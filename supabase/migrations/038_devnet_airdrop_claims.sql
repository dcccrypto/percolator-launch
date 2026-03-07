-- Migration: 038_devnet_airdrop_claims
-- Tracks devnet token airdrop claims to enforce 1-per-wallet-per-mint-per-24h
-- rate limit in a distributed-safe way (replaces in-memory Map in route.ts).
-- All operations use the service_role client which bypasses RLS.

CREATE TABLE IF NOT EXISTS devnet_airdrop_claims (
  id          BIGSERIAL     PRIMARY KEY,
  wallet      TEXT          NOT NULL,
  mint        TEXT          NOT NULL,
  claimed_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Enforce uniqueness per wallet+mint (only one active claim window)
CREATE UNIQUE INDEX IF NOT EXISTS devnet_airdrop_claims_wallet_mint_idx
  ON devnet_airdrop_claims(wallet, mint);

-- Speed up the "claimed within 24h?" lookup
CREATE INDEX IF NOT EXISTS devnet_airdrop_claims_claimed_at_idx
  ON devnet_airdrop_claims(claimed_at);

-- Auto-expire rows older than 25h (Postgres cron via pg_cron or manual cleanup).
-- Service_role has full access; anon/authenticated have no grants (RLS enabled).
ALTER TABLE devnet_airdrop_claims ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses RLS; no public access needed.
