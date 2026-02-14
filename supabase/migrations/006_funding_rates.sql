-- Funding Rates Infrastructure
-- Adds funding rate fields to market_stats and creates funding_history table

-- ============================================================================
-- Part 1: Extend market_stats with funding rate fields
-- ============================================================================

-- Add funding rate columns to market_stats
ALTER TABLE market_stats
  ADD COLUMN IF NOT EXISTS funding_rate_bps_per_slot BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS funding_index_qpb_e6 TEXT DEFAULT '0',
  ADD COLUMN IF NOT EXISTS net_lp_position TEXT DEFAULT '0',
  ADD COLUMN IF NOT EXISTS last_funding_slot BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS open_interest_long NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS open_interest_short NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mark_price NUMERIC,
  ADD COLUMN IF NOT EXISTS index_price NUMERIC;

-- Update existing open_interest column comment (commented out - column may not exist)
-- COMMENT ON COLUMN market_stats.open_interest IS 'Deprecated: use open_interest_long + open_interest_short';
COMMENT ON COLUMN market_stats.funding_rate_bps_per_slot IS 'Current funding rate in basis points per slot (i64)';
COMMENT ON COLUMN market_stats.funding_index_qpb_e6 IS 'Cumulative funding index (quote per base, scaled 1e6)';
COMMENT ON COLUMN market_stats.net_lp_position IS 'Net LP inventory position driving funding rate (I128)';
COMMENT ON COLUMN market_stats.last_funding_slot IS 'Last slot when funding was accrued';
COMMENT ON COLUMN market_stats.open_interest_long IS 'Total long positions (absolute value)';
COMMENT ON COLUMN market_stats.open_interest_short IS 'Total short positions (absolute value)';

-- Rename insurance_balance for clarity (commented out - column may not exist yet)
-- ALTER TABLE market_stats RENAME COLUMN insurance_balance TO insurance_fund;

-- ============================================================================
-- Part 2: Create funding_history table for time-series data
-- ============================================================================

CREATE TABLE IF NOT EXISTS funding_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  market_slab TEXT NOT NULL REFERENCES markets(slab_address) ON DELETE CASCADE,
  slot BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rate_bps_per_slot BIGINT NOT NULL,
  net_lp_pos TEXT NOT NULL,
  price_e6 BIGINT NOT NULL,
  funding_index_qpb_e6 TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient time-series queries
CREATE INDEX IF NOT EXISTS idx_funding_history_market_time 
  ON funding_history(market_slab, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_funding_history_slot 
  ON funding_history(market_slab, slot DESC);

-- RLS policies
ALTER TABLE funding_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON funding_history FOR SELECT USING (true);

-- ============================================================================
-- Part 3: Helper function to calculate annualized funding rate
-- ============================================================================

-- Solana slots: ~2.5 slots/second = 400ms per slot
-- Hourly slots: 3600s / 0.4s = 9000 slots
-- Daily slots: 24 * 9000 = 216,000 slots
-- Annual slots: 365 * 216,000 = 78,840,000 slots

CREATE OR REPLACE FUNCTION calculate_annualized_funding_rate(
  rate_bps_per_slot BIGINT
) RETURNS NUMERIC AS $$
BEGIN
  -- rate_bps_per_slot is in basis points (1 bps = 0.01%)
  -- Convert to percentage: rate_bps / 10000
  -- Annualize: * 78,840,000 slots/year
  RETURN (rate_bps_per_slot::NUMERIC / 10000.0) * 78840000.0;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION calculate_annualized_funding_rate IS 
  'Convert funding rate from bps/slot to annualized percentage (assumes 400ms slots)';

-- ============================================================================
-- Part 4: Update markets_with_stats view to include funding data
-- ============================================================================

DROP VIEW IF EXISTS markets_with_stats;
CREATE OR REPLACE VIEW markets_with_stats AS
SELECT
  m.*,
  s.last_price,
  s.mark_price,
  s.index_price,
  s.price_change_24h,
  s.volume_24h,
  s.open_interest,
  s.open_interest_long,
  s.open_interest_short,
  s.num_traders,
  s.vault_balance,
  -- s.insurance_fund, -- Column may not exist yet, will be added in migration 007
  s.last_crank_slot,
  s.funding_rate_bps_per_slot,
  s.funding_index_qpb_e6,
  s.net_lp_position,
  s.last_funding_slot,
  -- Calculated fields
  (s.funding_rate_bps_per_slot::NUMERIC / 10000.0) * 9000.0 AS funding_rate_hourly_percent,
  (s.funding_rate_bps_per_slot::NUMERIC / 10000.0) * 216000.0 AS funding_rate_daily_percent,
  calculate_annualized_funding_rate(s.funding_rate_bps_per_slot) AS funding_rate_annual_percent
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address;

COMMENT ON VIEW markets_with_stats IS 
  'Markets with latest stats including funding rates (hourly/daily/annual calculated)';
