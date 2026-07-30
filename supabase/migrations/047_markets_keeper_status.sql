-- 047: keeper_status — the single switch deciding whether the keeper prices a market.
--
-- Registration used to take two writes to two stores (the Vercel blob for the
-- keeper's list, Supabase for metadata) and nothing reconciled them. This column
-- is what lets the `markets` row become the single source of truth: the keeper
-- reads `keeper_status='active'` directly and reconciles against it, so retiring
-- a market is one UPDATE rather than edits to two hardcoded blocklists plus a
-- hand-edit of the keeper's local registry.
--
-- DEFAULT 'retired' is the safety property, not a convenience. The indexer's
-- syncMarkets() inserts a row for every slab it discovers on chain — measured
-- 2026-07-30, all 5 existing rows were created that way. With this default,
-- auto-discovery can never enroll a market for pricing; only the authenticated
-- registration endpoint (which proves on-chain marketauth) sets 'active'. That
-- is what makes it safe to point the keeper at a table the indexer writes to.
--
-- See docs/MARKET-REGISTRATION-SPEC-2026-07-30.md.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS keeper_status TEXT NOT NULL
  DEFAULT 'retired' CHECK (keeper_status IN ('active','retired'));

-- The keeper's only query filters on this; partial index keeps it cheap as the
-- table grows with retired rows.
CREATE INDEX IF NOT EXISTS idx_markets_keeper_active
  ON markets (network) WHERE keeper_status = 'active';

-- Reload PostgREST's schema cache so the column is immediately queryable by the
-- keeper's anon-key REST query.
NOTIFY pgrst, 'reload schema';
