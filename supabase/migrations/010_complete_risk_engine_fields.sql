-- Migration 010: Complete RiskEngine Field Coverage
-- Created: 2026-02-14
-- Purpose: Add ALL missing on-chain RiskEngine fields to market_stats

-- ============================================================================
-- 1. Add missing RiskEngine state fields
-- ============================================================================

-- Engine state fields
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS vault_balance NUMERIC DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS lifetime_liquidations BIGINT DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS lifetime_force_closes BIGINT DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS c_tot NUMERIC DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS pnl_pos_tot NUMERIC DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS last_crank_slot BIGINT DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS max_crank_staleness_slots BIGINT DEFAULT 0;

-- RiskParams fields (from on-chain params)
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS maintenance_fee_per_slot TEXT DEFAULT '0';
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS liquidation_fee_bps BIGINT DEFAULT 0;
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS liquidation_fee_cap TEXT DEFAULT '0';
ALTER TABLE market_stats ADD COLUMN IF NOT EXISTS liquidation_buffer_bps BIGINT DEFAULT 0;

-- ============================================================================
-- 2. Add column comments for documentation
-- ============================================================================

COMMENT ON COLUMN market_stats.vault_balance IS 'Total collateral deposited in vault (from engine.vault)';
COMMENT ON COLUMN market_stats.lifetime_liquidations IS 'Cumulative count of liquidations (from engine.lifetimeLiquidations)';
COMMENT ON COLUMN market_stats.lifetime_force_closes IS 'Cumulative count of force closes (from engine.lifetimeForceCloses)';
COMMENT ON COLUMN market_stats.c_tot IS 'Sum of all account capital - O(1) aggregate for haircut calc (from engine.cTot)';
COMMENT ON COLUMN market_stats.pnl_pos_tot IS 'Sum of all positive PnL - O(1) aggregate for haircut calc (from engine.pnlPosTot)';
COMMENT ON COLUMN market_stats.last_crank_slot IS 'Slot number of last crank execution (from engine.lastCrankSlot)';
COMMENT ON COLUMN market_stats.max_crank_staleness_slots IS 'Maximum allowed slots between cranks (from engine.maxCrankStalenessSlots)';
COMMENT ON COLUMN market_stats.maintenance_fee_per_slot IS 'Maintenance fee charged per slot (from params.maintenanceFeePerSlot, stored as string for u128)';
COMMENT ON COLUMN market_stats.liquidation_fee_bps IS 'Liquidation fee in basis points (from params.liquidationFeeBps)';
COMMENT ON COLUMN market_stats.liquidation_fee_cap IS 'Maximum liquidation fee cap (from params.liquidationFeeCap, stored as string for u128)';
COMMENT ON COLUMN market_stats.liquidation_buffer_bps IS 'Liquidation buffer in basis points (from params.liquidationBufferBps)';

-- ============================================================================
-- 3. Update markets_with_stats view to include ALL fields
-- ============================================================================

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
  -- New fields from migration 010
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

-- ============================================================================
-- Migration Complete
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 010 completed successfully';
  RAISE NOTICE 'Added 11 new columns to market_stats for complete RiskEngine coverage';
  RAISE NOTICE 'Updated markets_with_stats view to include all fields';
END $$;
