-- Referral tier system for the waitlist.
--
-- Each row gets an integer `tier` indicating its generation in the
-- referral tree:
--   tier 0  = "A" — root referrers (the 126 grandfathered signups
--                   who joined before invite-only)
--   tier 1  = "B" — referred by a tier-A user
--   tier 2  = "C" — referred by a tier-B user
--   …       continues alphabetically (Z = tier 25, then numeric)
--
-- A SECURITY DEFINER helper resolves a referrer's tier from a code,
-- so the signup route can compute the new row's tier with one RPC
-- call instead of an explicit SELECT (keeps the route's RLS posture
-- intact — it talks to functions, not rows).
--
-- Run this on the waitlist Supabase project (ref: pqivhfxyyswivraymlfu).
-- Idempotent — safe to re-run. Apply AFTER the privy_did migration.

-- ── Column ───────────────────────────────────────────────────────────
alter table public.waitlist
  add column if not exists tier int not null default 0;

-- Existing rows: all 126 pre-invite signups are tier 0 (= A).
-- The default already gave them that, but be explicit so re-running
-- after a partial deploy converges on the right state.
update public.waitlist set tier = 0 where tier is null;

-- ── Index ────────────────────────────────────────────────────────────
-- Used by the admin leaderboard tier breakdown and any future
-- "filter by tier" query.
create index if not exists waitlist_tier_idx on public.waitlist (tier);

-- ── Helper RPC: compute new row's tier from referrer code ────────────
--
-- The signup route calls this to derive the new row's tier without
-- needing a direct read on the waitlist table (preserves the
-- anon-no-SELECT invariant — the function is SECURITY DEFINER, the
-- anon caller never sees rows, only the resulting int).
--
-- Returns:
--   0   when p_code is null/empty (caller is a tier-A root signup —
--       shouldn't happen now that invite-only requires a referrer,
--       but kept for the grandfathered path)
--   N+1 when p_code matches a row with tier N
--   0   when p_code doesn't match any row (defensive — caller will
--       have already validated existence via waitlist_referral_code_exists)
create or replace function public.waitlist_tier_for_referrer(p_code text)
returns int
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select tier + 1 from public.waitlist where referral_code = p_code limit 1),
    0
  );
$$;

-- Service-role only — the signup route runs under service-role,
-- and exposing this to anon would let a public caller probe the
-- tier distribution of arbitrary codes (a weak side channel into
-- the referrer's identity, since tier correlates with join-order).
revoke all on function public.waitlist_tier_for_referrer(text) from public;
revoke all on function public.waitlist_tier_for_referrer(text) from anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.waitlist_tier_for_referrer(text) from authenticated';
  end if;
end $$;

-- ── Optional: tier breakdown view (admin reads via service-role) ─────
-- Convenience for the admin stats panel. Drop-and-recreate so re-runs
-- pick up any schema additions without manual migration.
create or replace function public.waitlist_tier_breakdown()
returns table (tier int, count bigint, label text)
language sql
security definer
set search_path = public
as $$
  with totals as (
    select tier, count(*)::bigint as cnt
    from public.waitlist
    group by tier
  )
  select
    tier,
    cnt as count,
    -- 'A' for tier 0 through 'Z' for tier 25; numeric beyond that.
    case
      when tier between 0 and 25 then chr(65 + tier)
      else 't' || tier::text
    end as label
  from totals
  order by tier asc;
$$;

revoke all on function public.waitlist_tier_breakdown() from public;
revoke all on function public.waitlist_tier_breakdown() from anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.waitlist_tier_breakdown() from authenticated';
  end if;
end $$;

-- ── Update the leaderboard RPC to include each row's tier ───────────
-- Keeps backward-compat: existing callers that ignore the new column
-- still work. New callers can read `tier` to render the A/B/C badge.
create or replace function public.waitlist_referral_leaderboard()
returns table (
  referral_code text,
  owner_pubkey text,
  owner_email text,
  twitter_handle text,
  signups_referred bigint,
  joined_at timestamptz,
  tier int
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
    w.created_at     as joined_at,
    w.tier
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

revoke all on function public.waitlist_referral_leaderboard() from public;
revoke all on function public.waitlist_referral_leaderboard() from anon;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.waitlist_referral_leaderboard() from authenticated';
  end if;
end $$;

-- ── Verification probes ──────────────────────────────────────────────
-- select * from public.waitlist_tier_breakdown();
-- select * from public.waitlist_referral_leaderboard() limit 5;
-- select public.waitlist_tier_for_referrer((select referral_code from public.waitlist limit 1));
