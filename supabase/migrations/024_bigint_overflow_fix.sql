-- Migration 024: Fix bigint overflow for large u64 on-chain values
-- Created: 2026-02-26
-- Purpose: Change BIGINT columns that may receive values > PG BIGINT MAX (9.2e18)
--          to NUMERIC type. On-chain u64 values can reach ~1.8e19 which overflows
--          PG signed BIGINT (max ~9.2e18).
--
-- Affected columns:
--   market_stats.lifetime_liquidations  (could be garbage from wrong slab layout)
--   market_stats.lifetime_force_closes  (same)
--
-- Note: last_crank_slot, max_crank_staleness_slots, warmup_period_slots,
--       liquidation_fee_bps, liquidation_buffer_bps stay BIGINT since their
--       realistic values are always well within range. The TypeScript indexer
--       now also clamps these at PG BIGINT MAX as a safety net.

-- Drop dependent view first
DROP VIEW IF EXISTS markets_with_stats;

-- Alter columns that can receive large u64 values
ALTER TABLE market_stats
  ALTER COLUMN lifetime_liquidations TYPE NUMERIC USING lifetime_liquidations::NUMERIC,
  ALTER COLUMN lifetime_force_closes TYPE NUMERIC USING lifetime_force_closes::NUMERIC;

-- Recreate the view (same as migration 010)
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

COMMENT ON VIEW markets_with_stats IS 'Combined view of markets and their complete stats (all RiskEngine fields)';

DO $$
BEGIN
  RAISE NOTICE 'Migration 024 completed: lifetime_liquidations and lifetime_force_closes changed from BIGINT to NUMERIC';
END $$;
