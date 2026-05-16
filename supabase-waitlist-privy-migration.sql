-- Privy DID integration for the waitlist.
--
-- Adds a single nullable column + an index so existing rows stay valid
-- (the 126 grandfathered signups have no privy_did yet — they'll get
-- backfilled opportunistically when the user next logs in via Privy).
--
-- Run this on the waitlist Supabase project (ref: pqivhfxyyswivraymlfu)
-- BEFORE deploying the code that references this column. Idempotent —
-- safe to re-run.

alter table public.waitlist
  add column if not exists privy_did text;

-- Each Privy user gets one waitlist row at most. Partial index lets the
-- 126 legacy rows (privy_did IS NULL) coexist without violating uniqueness.
create unique index if not exists waitlist_privy_did_unique_idx
  on public.waitlist (privy_did)
  where privy_did is not null;
