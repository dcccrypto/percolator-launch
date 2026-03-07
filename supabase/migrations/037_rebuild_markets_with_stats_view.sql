-- Migration 037: Rebuild markets_with_stats view to include oracle_mode and dex_pool_address
-- Root cause: PostgreSQL expands SELECT m.* at view-creation time. Columns added to markets
-- after migration 008 (oracle_mode, dex_pool_address from migration 035) are not reflected in
-- the view, causing "column markets_with_stats.oracle_mode does not exist" on /api/markets.
-- Fix: DROP and recreate the view so it picks up all current columns from markets.

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

COMMENT ON VIEW markets_with_stats IS 'Combined view of markets with their latest stats — includes oracle_mode, dex_pool_address (added migration 035), and all risk engine / transparency fields from migrations 007/010.';
