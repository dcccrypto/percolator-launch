-- Migration: 032_devnet_mints
-- Creates the devnet_mints table used by /api/devnet-mirror-mint and /api/devnet-pre-fund.
-- This table stores the mapping between mainnet token CAs and their devnet mirror mints,
-- enabling idempotent mint creation and dynamic pre-fund allowlisting.

CREATE TABLE IF NOT EXISTS devnet_mints (
  id           SERIAL        PRIMARY KEY,
  mainnet_ca   TEXT          NOT NULL UNIQUE,
  devnet_mint  TEXT          NOT NULL,
  symbol       TEXT,
  name         TEXT,
  decimals     INT           DEFAULT 6,
  logo_url     TEXT,
  creator_wallet TEXT,
  created_at   TIMESTAMPTZ   DEFAULT NOW()
);

-- Fast lookup by mainnet CA (primary uniqueness constraint)
CREATE UNIQUE INDEX IF NOT EXISTS devnet_mints_mainnet_ca_idx ON devnet_mints(mainnet_ca);

-- Fast lookup by devnet mint address (used in pre-fund allowlist check)
CREATE INDEX IF NOT EXISTS devnet_mints_devnet_mint_idx ON devnet_mints(devnet_mint);

-- Explicit RLS: deny all direct access; all operations use service_role client which bypasses RLS.
ALTER TABLE devnet_mints ENABLE ROW LEVEL SECURITY;
-- No policies needed: service_role bypasses RLS, anon/authenticated have no grants.
