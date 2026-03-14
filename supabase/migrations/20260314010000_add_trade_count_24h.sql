-- Migration 044: Add trade_count_24h to market_stats
-- StatsCollector already computes tradeCount via get24hVolume() but never stores it.
-- This adds the column and rebuilds the view so the API can expose it.
-- With an empty trades table, trade_count_24h will be 0 (not null) — cleaner than None.

ALTER TABLE market_stats
  ADD COLUMN IF NOT EXISTS trade_count_24h INT4 DEFAULT 0;

-- Rebuild markets_with_stats view to include the new column.
-- (PostgreSQL SELECT * in views is expanded at creation time, so we must DROP+recreate.)
DROP VIEW IF EXISTS markets_with_stats;

CREATE VIEW markets_with_stats AS
SELECT
  m.*,
  s.last_price,
  s.mark_price,
  s.index_price,
  s.volume_24h,
  s.trade_count_24h,
  s.volume_total,
  s.open_interest_long,
  s.open_interest_short,
  s.insurance_fund,
  s.total_accounts,
  s.funding_rate,
  -- Columns from migration 007 (hidden features)
  s.total_open_interest,
  s.net_lp_pos,
  s.lp_sum_abs,
  s.lp_max_abs,
  s.insurance_balance,
  s.insurance_fee_revenue,
  s.warmup_period_slots,
  -- Columns from migration 010 (complete risk engine)
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
  s.updated_at as stats_updated_at
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address;

COMMENT ON VIEW markets_with_stats IS 'Combined view of markets + stats. Includes trade_count_24h (migration 044) — 0 when trades table has no recent rows, null only for markets with no stats row yet.';

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
