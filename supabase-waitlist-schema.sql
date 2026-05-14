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
create or replace function public.waitlist_position(p_pubkey text)
returns bigint
language sql
security definer
set search_path = public
as $$
  with ordered as (
    select pubkey, row_number() over (order by created_at asc) as pos
    from public.waitlist
    where pubkey is not null
  )
  select pos from ordered where pubkey = p_pubkey;
$$;

grant execute on function public.waitlist_position(text) to anon;

-- Position lookup by email (case-insensitive). Used when the row was
-- inserted via the email path.
create or replace function public.waitlist_position_by_email(p_email text)
returns bigint
language sql
security definer
set search_path = public
as $$
  with ordered as (
    select email, row_number() over (order by created_at asc) as pos
    from public.waitlist
    where email is not null
  )
  select pos from ordered where lower(email) = lower(p_email);
$$;

grant execute on function public.waitlist_position_by_email(text) to anon;

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

-- ─── Verification probes ─────────────────────────────────────────────────────
-- select count(*) from public.waitlist;
-- select public.waitlist_count();
-- select count(*) from public.waitlist where referral_code is null;
-- select public.gen_crockford_code(8);
