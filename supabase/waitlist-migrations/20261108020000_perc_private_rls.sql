-- Defence in depth for the private allocation-checker + holder-vote schemas:
-- ROW LEVEL SECURITY on every table, with a policy for the SECURITY DEFINER
-- owner role perc_alloc_definer only.
--
-- !! APPLY AFTER 20261108000000_perc_alloc_private_lookup.sql AND
-- !! 20261108010000_perc_vote.sql, TO THE SAME DATABASE. Additive only (no DROP).
--
--   * anon / authenticated / service_role / PUBLIC already have NO privileges on
--     these schemas (revoked by the two migrations above). RLS adds a second
--     wall: even a mistaken future GRANT exposes no row without a policy.
--   * perc_alloc_definer (owner of the SECURITY DEFINER functions) keeps exactly
--     its table GRANTs; its policy is permissive, so behaviour is unchanged.
--   * The runtime role perc_alloc_reader gets NO policy and has no table GRANTs:
--     it can only EXECUTE the definer functions.
--   * The table owner (the migrator/import role) is not subject to RLS (no
--     FORCE), so the importer and operator verification queries are unchanged.
--
-- Idempotent: safe to run more than once.

begin;

do $$
declare
  t text;
begin
  foreach t in array array[
    'perc_alloc.snapshot', 'perc_alloc.holder', 'perc_alloc.rate_limit',
    'perc_vote.poll', 'perc_vote.nonce', 'perc_vote.ballot'
  ] loop
    execute format('alter table %s enable row level security', t);
    if not exists (
      select 1 from pg_policies
       where schemaname = split_part(t, '.', 1) and tablename = split_part(t, '.', 2)
         and policyname = 'perc_definer_only'
    ) then
      execute format('create policy perc_definer_only on %s as permissive for all to perc_alloc_definer using (true) with check (true)', t);
    end if;
  end loop;
end $$;

commit;

-- Verification (run as the owner):
-- select n.nspname, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname in ('perc_alloc', 'perc_vote') and c.relkind = 'r';          -- all true
-- select schemaname, tablename, policyname, roles from pg_policies
--  where schemaname in ('perc_alloc', 'perc_vote');                                 -- 6 rows, {perc_alloc_definer}
