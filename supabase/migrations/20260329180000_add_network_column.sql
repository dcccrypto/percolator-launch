-- Migration 20260329180000: Add network column for devnet/mainnet isolation
--
-- Context (PERC-8192): MAINNET-ENV.md pre-launch checklist item #3.
-- When mainnet Railway services point to the same Supabase project as devnet,
-- rows from both networks mix — corrupting analytics, trades, and market data.
--
-- Fix: add a `network` column (TEXT NOT NULL DEFAULT 'devnet') to all data
-- tables. Each service stamps its network at write time via NETWORK env var.
-- API queries filter by NETWORK env var so devnet and mainnet stay isolated.
--
-- Tables covered:
--   markets          — primary registry; all other tables FK back here
--   trades           — trade history per slab
--   oracle_prices    — price chart history
--   oi_history       — open interest time series
--   insurance_history — insurance fund time series
--   funding_history  — funding rate time series
--
-- market_stats does NOT get a network column: it has slab_address as PK which
-- is unique per network (same slab can't exist on both networks). Filtering via
-- the markets table join in markets_with_stats is sufficient.
--
-- Backfill: all existing rows are devnet → DEFAULT 'devnet' handles this.
--
-- Constraint: check (network in ('devnet', 'mainnet')) enforces valid values.
-- Index: network columns are indexed for fast WHERE network = $1 queries.

-- ============================================================================
-- 1. markets — add network column
-- ============================================================================

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_markets_network
  ON markets(network);

-- Partial index for active markets per network (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_markets_network_status
  ON markets(network, status);

COMMENT ON COLUMN markets.network IS 'Network this market belongs to: devnet or mainnet';

-- ============================================================================
-- 2. trades — add network column
-- ============================================================================

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_trades_network
  ON trades(network, slab_address, created_at DESC);

COMMENT ON COLUMN trades.network IS 'Network this trade was executed on: devnet or mainnet';

-- ============================================================================
-- 3. oracle_prices — add network column
-- ============================================================================

ALTER TABLE oracle_prices
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_oracle_prices_network
  ON oracle_prices(network, slab_address, timestamp DESC);

COMMENT ON COLUMN oracle_prices.network IS 'Network this price record belongs to: devnet or mainnet';

-- ============================================================================
-- 4. oi_history — add network column
-- ============================================================================

ALTER TABLE oi_history
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_oi_history_network
  ON oi_history(network, market_slab, timestamp DESC);

COMMENT ON COLUMN oi_history.network IS 'Network this OI snapshot belongs to: devnet or mainnet';

-- ============================================================================
-- 5. insurance_history — add network column
-- ============================================================================

ALTER TABLE insurance_history
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_insurance_history_network
  ON insurance_history(network, market_slab, timestamp DESC);

COMMENT ON COLUMN insurance_history.network IS 'Network this insurance snapshot belongs to: devnet or mainnet';

-- ============================================================================
-- 6. funding_history — add network column
-- ============================================================================

ALTER TABLE funding_history
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_funding_history_network
  ON funding_history(network, market_slab, timestamp DESC);

COMMENT ON COLUMN funding_history.network IS 'Network this funding rate record belongs to: devnet or mainnet';

-- ============================================================================
-- 7. insurance_snapshots and insurance_lp_events — add network column
-- ============================================================================

ALTER TABLE insurance_snapshots
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_insurance_snapshots_network
  ON insurance_snapshots(network, slab_address, timestamp DESC);

COMMENT ON COLUMN insurance_snapshots.network IS 'Network this snapshot belongs to: devnet or mainnet';

ALTER TABLE insurance_lp_events
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'devnet'
    CHECK (network IN ('devnet', 'mainnet'));

CREATE INDEX IF NOT EXISTS idx_insurance_lp_events_network
  ON insurance_lp_events(network, slab_address, timestamp DESC);

COMMENT ON COLUMN insurance_lp_events.network IS 'Network this event belongs to: devnet or mainnet';

-- ============================================================================
-- 8. Rebuild markets_with_stats view to expose network column
-- ============================================================================

DROP VIEW IF EXISTS markets_with_stats;

CREATE VIEW markets_with_stats AS
SELECT
  m.*,
  s.last_price,
  s.mark_price,
  s.index_price,
  s.volume_24h,
  s.volume_total,
  s.open_interest_long,
  s.open_interest_short,
  s.insurance_fund,
  s.total_accounts,
  s.funding_rate,
  -- Hidden features (migration 007)
  s.total_open_interest,
  s.net_lp_pos,
  s.lp_sum_abs,
  s.lp_max_abs,
  s.insurance_balance,
  s.insurance_fee_revenue,
  s.warmup_period_slots,
  -- Complete RiskEngine fields (migration 010)
  s.vault_balance,
  s.lifetime_liquidations,
  s.lifetime_force_closes,
  s.c_tot,
  s.pnl_pos_tot,
  s.last_crank_slot,
  s.max_crank_staleness_slots,
  s.maintenance_fee_per_slot,
  s.liquidation_fee_bps,
  s.liquidation_fee_cap,
  s.liquidation_buffer_bps,
  s.updated_at AS stats_updated_at
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address;

COMMENT ON VIEW markets_with_stats IS 'Combined view of markets with their latest stats. Callers MUST filter by network column to avoid cross-network data mixing.';

-- ============================================================================
-- Verification
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 20260329180000 completed: network column added to markets, trades, oracle_prices, oi_history, insurance_history, funding_history, insurance_snapshots, insurance_lp_events';
  RAISE NOTICE 'All existing rows backfilled to network=devnet via column DEFAULT';
  RAISE NOTICE 'Rebuild markets_with_stats view to expose m.network';
  RAISE NOTICE 'Next: deploy updated API/indexer/keeper with NETWORK env var set';
END $$;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
