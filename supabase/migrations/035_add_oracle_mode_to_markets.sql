-- PERC-470: Add oracle_mode and dex_pool_address columns to markets table
-- oracle_mode: 'pyth' | 'hyperp' | 'admin' (default 'admin' for existing markets)
-- dex_pool_address: PumpSwap/Raydium/Meteora pool address for hyperp mode

ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS oracle_mode TEXT NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS dex_pool_address TEXT;

-- Index for filtering hyperp markets (keeper/crank queries)
CREATE INDEX IF NOT EXISTS idx_markets_oracle_mode ON markets (oracle_mode);
