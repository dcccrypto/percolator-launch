-- Percolator Launch — Seed Data
-- Reference data and initial records for development and testing
-- Run after migrations: supabase db seed

-- ============================================================================
-- 1. Admin Users (Example - replace with real emails)
-- ============================================================================

INSERT INTO admin_users (email, role)
VALUES 
  ('admin@percolator.com', 'admin'),
  ('dev@percolator.com', 'developer')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- 2. Example Market (for local development)
-- ============================================================================

-- Only insert if not exists (check by slab_address)
INSERT INTO markets (
  slab_address,
  mint_address,
  symbol,
  name,
  decimals,
  deployer,
  oracle_authority,
  initial_price_e6,
  max_leverage,
  trading_fee_bps
)
VALUES (
  'DevMarket1111111111111111111111111111111',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', -- USDC mint
  'SOL-PERP',
  'Solana Perpetual',
  6,
  'DevDeployer11111111111111111111111111111',
  'DevOracle111111111111111111111111111111',
  '100000000', -- $100
  20,
  10 -- 0.1%
)
ON CONFLICT (slab_address) DO NOTHING;

-- Corresponding market_stats
INSERT INTO market_stats (
  slab_address,
  last_price,
  mark_price,
  index_price,
  volume_24h,
  volume_total,
  open_interest_long,
  open_interest_short,
  insurance_fund,
  total_accounts,
  funding_rate,
  vault_balance,
  total_open_interest,
  net_lp_pos,
  lp_sum_abs,
  lp_max_abs,
  insurance_balance,
  insurance_fee_revenue,
  warmup_period_slots
)
VALUES (
  'DevMarket1111111111111111111111111111111',
  100.00,
  100.05,
  100.00,
  0,
  0,
  0,
  0,
  1000.00,
  0,
  0.0001,
  10000.00,
  0,
  0,
  0,
  0,
  1000.00,
  50.00,
  1000
)
ON CONFLICT (slab_address) DO UPDATE SET
  last_price = EXCLUDED.last_price,
  updated_at = NOW();

-- ============================================================================
-- 3. Example Oracle Price (for local development)
-- ============================================================================

INSERT INTO oracle_prices (
  slab_address,
  price_e6,
  source,
  timestamp
)
VALUES (
  'DevMarket1111111111111111111111111111111',
  '100000000',
  'pyth',
  EXTRACT(EPOCH FROM NOW())::BIGINT
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. Simulation tables removed (PRs #225-#227, 2026-02-19)
-- ============================================================================
-- simulation_sessions and simulation_price_history no longer exist

-- ============================================================================
-- 5. Solana Program IDs (Reference Data - if needed by the app)
-- ============================================================================

-- Note: If you create a programs table in the future, add it here
-- For now, these are documented in the README or environment variables

-- Example:
-- CREATE TABLE IF NOT EXISTS programs (
--   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
--   name TEXT UNIQUE NOT NULL,
--   program_id TEXT UNIQUE NOT NULL,
--   description TEXT,
--   network TEXT NOT NULL DEFAULT 'mainnet-beta'
-- );
-- 
-- INSERT INTO programs (name, program_id, description, network)
-- VALUES 
--   ('percolator', 'Perco1atorProgramID1111111111111111111', 'Main Percolator perpetuals program', 'mainnet-beta'),
--   ('oracle', 'Oracle1ProgramID11111111111111111111111', 'Price oracle program', 'mainnet-beta'),
--   ('insurance', 'Insurance1ProgramID111111111111111111', 'Insurance fund program', 'mainnet-beta')
-- ON CONFLICT (program_id) DO NOTHING;

-- ============================================================================
-- Seed Complete
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Seed data loaded successfully';
  RAISE NOTICE 'Dev market: DevMarket1111111111111111111111111111111';
  RAISE NOTICE 'Admin users: admin@percolator.com, dev@percolator.com';
END $$;
