-- GH#2503 — waitlist: remove the anon INSERT path on the LIVE waitlist project.
--
-- !! APPLY TO THE WAITLIST SUPABASE PROJECT ONLY (the one behind
-- !! NEXT_PUBLIC_WAITLIST_SUPABASE_URL). This is NOT the trading/indexer project,
-- !! which is why this file lives in supabase/waitlist-migrations/ and NOT in
-- !! supabase/migrations/ (that directory is for the trading project; a CLI or
-- !! GitHub-integration push of it would target the wrong database).
--
-- Repo side already merged in #2540 (supabase-waitlist-schema.sql + signup route
-- inserting via getWaitlistServiceSupabase()). This file is the idempotent,
-- apply-only delta for the already-provisioned live database, where the
-- original policy is still:
--     create policy "anon insert" on public.waitlist for insert to anon with check (true);
--
-- Idempotent: safe to run more than once. Does not touch data.

begin;

alter table public.waitlist enable row level security;

-- 1. The fix: remove every write policy that applies to anon/authenticated.
drop policy if exists "anon insert" on public.waitlist;
drop policy if exists "service_role insert" on public.waitlist;

-- 2. Document the intended writer (service_role bypasses RLS regardless; this is
--    stated intent, not protection).
create policy "service_role insert"
  on public.waitlist
  for insert
  to service_role
  with check (true);

-- 3. Defence in depth: even if someone re-adds an anon policy, table privileges
--    no longer permit writes or reads by the publishable-key roles.
--    (Public reads go through the SECURITY DEFINER functions, which are unaffected.)
revoke insert, update, delete, truncate on public.waitlist from anon, authenticated;
revoke select on public.waitlist from anon, authenticated;

commit;

-- ─── Verification (run after applying; expect the results in the comments) ────
-- select policyname, roles, cmd from pg_policies where tablename = 'waitlist';
--   -> exactly one row: service_role insert | {service_role} | INSERT
-- select has_table_privilege('anon', 'public.waitlist', 'INSERT');   -- false
-- select has_function_privilege('anon', 'public.waitlist_count()', 'EXECUTE');  -- true (unchanged)
-- Then, from outside, with the PUBLISHABLE key:
--   curl -s -X POST "$WAITLIST_URL/rest/v1/waitlist" -H "apikey: $ANON" \
--     -H "Content-Type: application/json" -d '{"twitter_handle":"rls_probe"}'
--   -> HTTP 401/403 (permission denied / RLS violation), NOT 201.
--
-- ─── Rollback (only if signups break unexpectedly) ────────────────────────────
-- grant insert on public.waitlist to anon;
-- create policy "anon insert" on public.waitlist for insert to anon with check (true);
-- (this re-opens the hole; prefer fixing the route's client instead)
