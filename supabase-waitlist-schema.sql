-- Waitlist schema — run this on the new Supabase project
-- (project ref: pqivhfxyyswivraymlfu)
--
-- Design:
-- - Anonymous users insert via the publishable key (RLS allows insert only)
-- - Server-side route /api/waitlist/signup verifies the wallet signature
--   BEFORE inserting, so RLS-allowed inserts are gated on real ownership.
-- - SELECT is denied to anon (privacy: don't leak the email-list-equivalent).
-- - Counter is exposed via a SECURITY DEFINER function callable by anon.
--
-- High-intent signal: each row is keyed by Solana wallet pubkey + a
-- signed message proving ownership.  Email is optional and not used
-- in the MVP.

-- Extensions
create extension if not exists "pgcrypto";

-- Main table
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  pubkey text not null unique,
  signature text not null,
  message text not null,
  twitter_handle text,
  source text,
  user_agent text,
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists waitlist_created_at_idx
  on public.waitlist (created_at desc);

-- Row-level security
alter table public.waitlist enable row level security;

-- Drop existing policies if re-running this script
drop policy if exists "anon insert" on public.waitlist;
drop policy if exists "deny select" on public.waitlist;

-- Anon can insert (server-side route validates the signature first)
create policy "anon insert"
  on public.waitlist
  for insert
  to anon
  with check (true);

-- Anon cannot read individual rows (privacy)
-- (intentionally no select policy = deny by default under RLS)

-- Public counter via SECURITY DEFINER function
create or replace function public.waitlist_count()
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*) from public.waitlist;
$$;

grant execute on function public.waitlist_count() to anon;

-- Position lookup for a given pubkey (for "you're #N on the list" UX)
create or replace function public.waitlist_position(p_pubkey text)
returns bigint
language sql
security definer
set search_path = public
as $$
  with ordered as (
    select pubkey, row_number() over (order by created_at asc) as pos
    from public.waitlist
  )
  select pos from ordered where pubkey = p_pubkey;
$$;

grant execute on function public.waitlist_position(text) to anon;

-- Verification probe (for debugging the schema is right)
-- select count(*) from public.waitlist;
-- select public.waitlist_count();
