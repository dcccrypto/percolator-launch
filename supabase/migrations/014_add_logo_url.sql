-- Add logo_url column to markets table
ALTER TABLE markets ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Update the markets_with_stats view to include logo_url
CREATE OR REPLACE VIEW markets_with_stats AS
SELECT
  m.*,
  ms.current_price_e6,
  ms.oracle_price_e6,
  ms.funding_rate_bps,
  ms.total_open_interest_e6,
  ms.insurance_balance_e6,
  ms.insurance_fee_revenue_e6,
  ms.insurance_health_ratio,
  ms.vault_balance_e6,
  ms.lifetime_liquidations,
  ms.lifetime_force_closes,
  ms.c_tot_e6,
  ms.pnl_pos_tot_e6,
  ms.lp_net_pos,
  ms.lp_sum_abs,
  ms.lp_max_abs,
  ms.crank_staleness_slots,
  ms.last_crank_slot,
  ms.risk_reduction_threshold,
  ms.maintenance_margin_bps,
  ms.initial_margin_bps,
  ms.volume_24h,
  ms.trades_24h,
  ms.high_24h,
  ms.low_24h,
  ms.price_change_24h_pct,
  ms.last_updated
FROM markets m
LEFT JOIN market_stats ms ON m.slab_address = ms.slab_address;
