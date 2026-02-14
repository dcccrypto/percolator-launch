-- Update market_stats schema to match StatsCollector writes
-- This migration aligns the DB schema with the actual data being written

-- Drop the old view first
DROP VIEW IF EXISTS markets_with_stats;

-- Alter market_stats table to match StatsCollector fields
ALTER TABLE market_stats
  DROP COLUMN IF EXISTS price_change_24h,
  DROP COLUMN IF EXISTS open_interest,
  DROP COLUMN IF EXISTS num_traders,
  DROP COLUMN IF EXISTS vault_balance,
  DROP COLUMN IF EXISTS insurance_balance,
  DROP COLUMN IF EXISTS last_crank_slot,
  ADD COLUMN IF NOT EXISTS mark_price NUMERIC,
  ADD COLUMN IF NOT EXISTS index_price NUMERIC,
  ADD COLUMN IF NOT EXISTS volume_total NUMERIC,
  ADD COLUMN IF NOT EXISTS open_interest_long NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS open_interest_short NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_fund NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_accounts INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS funding_rate NUMERIC DEFAULT 0;

-- Recreate the view with updated fields
CREATE OR REPLACE VIEW markets_with_stats AS
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
  s.updated_at as stats_updated_at
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address;

-- Add index for faster stats lookups
CREATE INDEX IF NOT EXISTS idx_market_stats_updated ON market_stats(updated_at DESC);
