-- PERC-372: Auto-fund log + airdrop_claims tables for devnet faucet

CREATE TABLE IF NOT EXISTS auto_fund_log (
  id BIGSERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  sol_airdropped BOOLEAN NOT NULL DEFAULT FALSE,
  usdc_minted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auto_fund_wallet_time ON auto_fund_log (wallet, created_at DESC);

-- Enable RLS but allow service role full access
ALTER TABLE auto_fund_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_auto_fund" ON auto_fund_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Airdrop claims (if not exists — may already be from PERC-363)
CREATE TABLE IF NOT EXISTS airdrop_claims (
  id BIGSERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  market_address TEXT NOT NULL,
  amount_tokens DOUBLE PRECISION,
  amount_usd DOUBLE PRECISION,
  signature TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_airdrop_claims_wallet ON airdrop_claims (wallet, market_address, claimed_at DESC);

ALTER TABLE airdrop_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_airdrop_claims" ON airdrop_claims FOR ALL TO service_role USING (true) WITH CHECK (true);
