-- PERC-375: Auto-fund faucet rate-limit log
-- Tracks when wallets receive devnet SOL airdrops and test USDC mints
-- to enforce 1-claim-per-wallet-per-24h rate limiting.

CREATE TABLE IF NOT EXISTS auto_fund_log (
  id BIGSERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  sol_airdropped BOOLEAN DEFAULT FALSE,
  usdc_minted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for rate-limit lookups: wallet + time
CREATE INDEX idx_auto_fund_log_wallet_time
  ON auto_fund_log(wallet, created_at DESC);

-- RLS: service role only (server-side API route writes here)
ALTER TABLE auto_fund_log ENABLE ROW LEVEL SECURITY;

-- No public read needed — only the API route accesses this table via service key
CREATE POLICY "auto_fund_log_service_insert"
  ON auto_fund_log FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "auto_fund_log_service_select"
  ON auto_fund_log FOR SELECT
  TO service_role
  USING (true);

-- Auto-cleanup: purge entries older than 7 days (optional cron via pg_cron if available)
COMMENT ON TABLE auto_fund_log IS 'Rate-limit log for devnet auto-fund faucet. Entries older than 7 days can be safely purged.';
