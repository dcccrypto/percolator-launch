-- Migration 037: Rebuild markets_with_stats view to include oracle_mode + dex_pool_address
-- 
-- Migration 035 added oracle_mode and dex_pool_address to the markets table,
-- but the markets_with_stats view (last rebuilt in migration 024) was not
-- recreated afterward. PostgreSQL expands SELECT m.* at CREATE VIEW time,
-- so the view's stored column list was frozen without the new columns.
--
-- This caused: "column markets_with_stats.oracle_mode does not exist"
-- on the /api/markets endpoint (reported by devops, PERC-486).

DROP VIEW IF EXISTS markets_with_stats;

CREATE VIEW markets_with_stats AS
SELECT 
  m.*,
  ms.last_price,
  ms.mark_price,
  ms.index_price,
  ms.volume_24h,
  ms.volume_total,
  ms.open_interest_long,
  ms.open_interest_short,
  ms.insurance_fund,
  ms.total_accounts,
  ms.funding_rate,
  ms.total_open_interest,
  ms.net_lp_pos,
  ms.lp_sum_abs,
  ms.lp_max_abs,
  ms.insurance_balance,
  ms.insurance_fee_revenue,
  ms.warmup_period_slots,
  ms.vault_balance,
  ms.lifetime_liquidations,
  ms.lifetime_force_closes,
  ms.c_tot,
  ms.pnl_pos_tot,
  ms.last_crank_slot,
  ms.max_crank_staleness_slots,
  ms.maintenance_fee_per_slot,
  ms.liquidation_fee_bps,
  ms.liquidation_fee_cap,
  ms.liquidation_buffer_bps,
  ms.updated_at AS stats_updated_at
FROM markets m
LEFT JOIN market_stats ms ON m.slab_address = ms.slab_address;

COMMENT ON VIEW markets_with_stats IS 'Combined view of markets and their complete stats — includes oracle_mode and dex_pool_address from markets table';

-- Notify PostgREST to pick up schema changes
NOTIFY pgrst, 'reload schema';
