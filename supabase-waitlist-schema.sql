-- Waitlist schema — run this on the waitlist Supabase project
-- (project ref: pqivhfxyyswivraymlfu)
--
-- This file is idempotent. Run it on a fresh project to bootstrap, or
-- on the live project to apply pending changes — both reach the same
-- end state.
--
-- Design:
-- - Anonymous users insert via the publishable key (RLS allows insert only).
-- - Server-side route /api/waitlist/signup verifies the wallet signature
--   BEFORE inserting, so RLS-allowed inserts are gated on real ownership.
-- - SELECT is denied to anon (privacy: don't leak the email-list-equivalent).
-- - Counter + position lookups + referral-code presence checks are exposed
--   via SECURITY DEFINER functions callable by anon.
--
-- Inputs we accept: wallet-only (pubkey + signature + message), email-only,
-- or both (Privy email login → embedded wallet → signed message). At least
-- one of pubkey or email must be present.

create extension if not exists "pgcrypto";

-- ─── Main table ──────────────────────────────────────────────────────────────

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  pubkey text unique,
  email text,
  signature text,
  message text,
  twitter_handle text,
  source text,
  user_agent text,
  ip_hash text,
  referral_code text unique,
  referred_by_code text,
  created_at timestamptz not null default now(),
  constraint waitlist_pubkey_or_email check (pubkey is not null or email is not null)
);

-- Idempotent reconciliation for projects bootstrapped before the email path
-- existed (pubkey/signature/message were originally NOT NULL).
alter table public.waitlist alter column pubkey drop not null;
alter table public.waitlist alter column signature drop not null;
alter table public.waitlist alter column message drop not null;

-- Idempotent column adds (for projects that pre-date these columns).
alter table public.waitlist add column if not exists email text;
alter table public.waitlist add column if not exists referral_code text;
alter table public.waitlist add column if not exists referred_by_code text;

-- IP tracking for bot/abuse defense. Two complementary columns:
--   • ip_address (inet): the raw IPv4/IPv6 the request arrived from, used
--     by the operator for one-off forensic lookups in /admin. Stored raw
--     so an operator can match a signup against a known bad host without
--     a hashing key. Considered PII; the retention policy is operator-set
--     (e.g. a cron that nulls ip_address older than 90 days while keeping
--     ip_hash for analytics).
--   • ip_hash (text): SHA-256 of the ip_address with a server-side salt,
--     populated by the signup route alongside ip_address. Drives the
--     velocity / cross-referrer signals in the admin spam panel. Safe to
--     retain indefinitely because the salt is server-side and rotation
--     of the salt unlinks past hashes from future ones.
-- Both columns are nullable: legacy rows pre-date the capture, and a few
-- proxies can strip the forwarding headers (the route handles that by
-- writing NULL rather than failing the signup).
--
-- Both ALTERs are explicit because the CREATE TABLE above is gated on
-- IF NOT EXISTS — projects bootstrapped before either column was added
-- to this file would otherwise skip the create AND have no alter to
-- catch up, leaving the downstream index creation to fail with
-- "column does not exist".
alter table public.waitlist add column if not exists ip_address inet;
alter table public.waitlist add column if not exists ip_hash text;
-- "Have we emailed this user their referral code?" Set by the signup route
-- after a successful confirmation send (new signups) and by the one-time
-- backfill script (pre-existing signups). Lets the backfill be re-runnable
-- safely — anyone already notified is skipped.
alter table public.waitlist
  add column if not exists referral_code_emailed_at timestamptz;

-- Unique constraint on referral_code (idempotent via pg_constraint check).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'waitlist_referral_code_key'
      and conrelid = 'public.waitlist'::regclass
  ) then
    alter table public.waitlist
      add constraint waitlist_referral_code_key unique (referral_code);
  end if;
end $$;

-- pubkey-or-email check constraint (idempotent).
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'waitlist_pubkey_or_email'
      and conrelid = 'public.waitlist'::regclass
  ) then
    alter table public.waitlist
      add constraint waitlist_pubkey_or_email
      check (pubkey is not null or email is not null);
  end if;
end $$;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

create index if not exists waitlist_created_at_idx
  on public.waitlist (created_at desc);

-- Case-insensitive uniqueness for emails (partial — pubkey-only rows have NULL email).
create unique index if not exists waitlist_email_unique_idx
  on public.waitlist (lower(email))
  where email is not null;

-- Lookup index for referral attribution (partial — older rows may have NULL).
create index if not exists waitlist_referral_code_idx
  on public.waitlist (referral_code)
  where referral_code is not null;

-- Reverse-lookup index for the leaderboard: count signups grouped by who
-- referred them. Partial — most rows have NULL (joined without a referrer).
create index if not exists waitlist_referred_by_code_idx
  on public.waitlist (referred_by_code)
  where referred_by_code is not null;

-- IP-velocity index for the admin spam-signals panel. Hash, not raw — the
-- velocity queries group by ip_hash so a single botnet rotating IP-text-
-- across-runs but reusing the same source still aggregates correctly when
-- the salt is stable, and an operator who rotates the salt deliberately
-- breaks that aggregation as a recovery action. Partial — legacy rows
-- and the rare strip-forwarding-header signups have NULL.
--
-- CONCURRENTLY avoids the ACCESS EXCLUSIVE lock a plain CREATE INDEX
-- would take during build — which would block every signup INSERT for
-- the duration. On a small table the difference is sub-second but the
-- schema file is meant to be safely re-runnable against the live
-- project, so we use the safer form. CONCURRENTLY cannot run inside a
-- transaction block — Supabase's SQL editor runs each top-level
-- statement standalone so this is fine, but anyone wrapping the whole
-- file in BEGIN/COMMIT must run this statement separately.
create index concurrently if not exists waitlist_ip_hash_idx
  on public.waitlist (ip_hash)
  where ip_hash is not null;

-- ─── Crockford base32 code generator ────────────────────────────────────────
-- Alphabet excludes I, L, O, U — avoids visual confusion (1/I, 0/O) and the
-- only English vowel that turns short random strings into accidental words.
-- 8 characters ≈ 1.1 trillion codes; way more than the waitlist will ever hold.

create or replace function public.gen_crockford_code(n int)
returns text
language plpgsql
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  result text := '';
  bytes bytea;
  i int;
begin
  if n < 1 or n > 64 then
    raise exception 'gen_crockford_code: n must be 1..64';
  end if;
  bytes := gen_random_bytes(n);
  for i in 0..(n - 1) loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

-- ─── One-time email normalisation ───────────────────────────────────────────
-- The signup route lowercases inbound emails (route.ts line ~265) and the
-- unique index is on lower(email) — but rows inserted before that policy
-- existed may store mixed-case emails. The route's referral-code-emailed
-- flag update matches on `eq("email", lower(...))`, which silently misses
-- those pre-normalised rows. Normalise once here so equality matches
-- always succeed. Idempotent: re-runs are no-ops because the WHERE clause
-- already excludes already-normalised rows.
update public.waitlist
set email = lower(email)
where email is not null and email != lower(email);

-- ─── Backfill: assign codes to any existing rows that don't have one ────────
-- Retries on the (astronomically unlikely) unique-violation. Safe to re-run.

do $$
declare
  r record;
  attempt int;
  code text;
begin
  for r in select id from public.waitlist where referral_code is null loop
    attempt := 0;
    loop
      attempt := attempt + 1;
      if attempt > 8 then
        raise exception 'referral code backfill: 8 collisions for row %, aborting', r.id;
      end if;
      code := public.gen_crockford_code(8);
      begin
        update public.waitlist set referral_code = code where id = r.id;
        exit;
      exception when unique_violation then
        -- collision — try a fresh code
        continue;
      end;
    end loop;
  end loop;
end;
$$;

-- ─── Row-level security ──────────────────────────────────────────────────────

alter table public.waitlist enable row level security;

drop policy if exists "anon insert" on public.waitlist;
drop policy if exists "deny select" on public.waitlist;

-- Anon can insert (server-side route validates the signature first).
create policy "anon insert"
  on public.waitlist
  for insert
  to anon
  with check (true);

-- Anon cannot read individual rows. Intentionally no select policy →
-- deny by default under RLS. Public access goes through the SECURITY
-- DEFINER functions below.

-- ─── Public functions (anon-callable, SECURITY DEFINER) ──────────────────────

-- Total count (used by the status pill, not the public counter).
create or replace function public.waitlist_count()
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*) from public.waitlist;
$$;

grant execute on function public.waitlist_count() to anon;

-- Position lookup by pubkey ("you're #N on the list").
-- row_number() runs over the ENTIRE table so wallet and email signups
-- share one ordering. The previous version filtered `pubkey is not null`
-- (mirror clause for email) which gave each user a position inside their
-- own signup-method subset — about half the real list size.
create or replace function public.waitlist_position(p_pubkey text)
returns bigint
language sql
security definer
set search_path = public
as $$
  with ordered as (
    select pubkey, row_number() over (order by created_at asc, id asc) as pos
    from public.waitlist
  )
  select pos from ordered where pubkey = p_pubkey;
$$;

-- Revoked from anon (was previously granted): a public membership lookup
-- by pubkey is a low-grade enumeration vector. The signup route is the only
-- legitimate caller and it now uses the service-role client. Counter is
-- still public via waitlist_count() — only individual-row probes are gated.
revoke execute on function public.waitlist_position(text) from anon;

-- Position lookup by email (case-insensitive). Used when the row was
-- inserted via the email path.
create or replace function public.waitlist_position_by_email(p_email text)
returns bigint
language sql
security definer
set search_path = public
as $$
  with ordered as (
    select email, row_number() over (order by created_at asc, id asc) as pos
    from public.waitlist
  )
  select pos from ordered where lower(email) = lower(p_email);
$$;

-- Revoked from anon (was previously granted): an anon caller holding the
-- publishable key could probe arbitrary emails for membership, turning the
-- function into a clean yes/no oracle on a PII-grade identifier. The
-- signup route is the only legitimate caller and uses the service-role
-- client.
revoke execute on function public.waitlist_position_by_email(text) from anon;

-- Referral code existence check (boolean only — never returns the row).
-- Used by future attribution: a visitor lands at /r/<code> and we confirm
-- the code is real without exposing who owns it.
create or replace function public.waitlist_referral_code_exists(p_code text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.waitlist where referral_code = p_code
  );
$$;

grant execute on function public.waitlist_referral_code_exists(text) to anon;

-- ─── Operator-only: referral leaderboard ────────────────────────────────────
-- WHO USES THIS: only the operator, via the service-role key (server-side
--   or `psql` with the project's database URL). Never callable by anon or
--   authenticated users — anon is the role the publishable key maps to,
--   and exposing the full pubkey/email columns would defeat the privacy
--   posture of the rest of the schema (no anon SELECT on rows).
--
-- HOW TO QUERY:
--   • Supabase SQL editor (logged in as project owner):
--       select * from public.waitlist_referral_leaderboard();
--   • psql with the DB URL:
--       psql "$WAITLIST_DB_URL" -c \
--         'select * from public.waitlist_referral_leaderboard() limit 50;'
--   • Server-side from Node:
--       supabase.rpc("waitlist_referral_leaderboard")
--     where `supabase` was constructed with WAITLIST_SUPABASE_SERVICE_ROLE_KEY
--     (see app/lib/waitlist/supabase.ts → getWaitlistServiceSupabase).
--
-- WHY IT'S TAMPER-RESISTANT:
--   • referred_by_code is set at INSERT time by the signup route. The route
--     never UPDATEs it afterwards.
--   • The RLS policy on the waitlist table grants anon INSERT only — no
--     UPDATE or DELETE policy exists, so anon cannot mutate the column.
--   • This function reads `count(*)` of rows that reference each code; an
--     attacker would need INSERT access to a row with a chosen
--     referred_by_code (which they have — but their inserted row is then
--     subject to the same RLS, and the route validates `referred_by_code`
--     points at a real code before accepting). They cannot decrement, edit
--     ownership of, or hide existing referrals.
--   • Service role bypasses RLS but the service-role key lives in operator
--     env (Vercel project + local .env), not in the browser bundle.
create or replace function public.waitlist_referral_leaderboard()
returns table (
  referral_code text,
  owner_pubkey text,
  owner_email text,
  twitter_handle text,
  signups_referred bigint,
  joined_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    w.referral_code,
    w.pubkey         as owner_pubkey,
    w.email          as owner_email,
    w.twitter_handle,
    coalesce(c.cnt, 0) as signups_referred,
    w.created_at     as joined_at
  from public.waitlist w
  left join (
    select referred_by_code, count(*) as cnt
    from public.waitlist
    where referred_by_code is not null
    group by referred_by_code
  ) c on c.referred_by_code = w.referral_code
  where w.referral_code is not null
  order by signups_referred desc, w.created_at asc;
$$;

-- Lock down: NOT callable by anon or authenticated. Service role only.
revoke all on function public.waitlist_referral_leaderboard() from public;
revoke all on function public.waitlist_referral_leaderboard() from anon;
-- The `authenticated` role exists on Supabase projects with auth turned on;
-- the revoke is a no-op on projects that don't have it, so it's safe to
-- include unconditionally.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.waitlist_referral_leaderboard() from authenticated';
  end if;
end $$;

-- ─── Verification probes ─────────────────────────────────────────────────────
-- select count(*) from public.waitlist;
-- select public.waitlist_count();
-- select count(*) from public.waitlist where referral_code is null;
-- select public.gen_crockford_code(8);
