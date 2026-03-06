-- Migration: 033_markets_mainnet_ca
-- Adds mainnet_ca column to markets table for oracle keeper auto-discovery.
-- The oracle keeper needs the mainnet token CA to fetch real-time prices.

ALTER TABLE markets ADD COLUMN IF NOT EXISTS mainnet_ca TEXT;

-- Index for oracle keeper queries: find markets that need price feeds
CREATE INDEX IF NOT EXISTS markets_mainnet_ca_idx ON markets(mainnet_ca) WHERE mainnet_ca IS NOT NULL;

-- Backfill from devnet_mints table where possible
UPDATE markets m
SET mainnet_ca = dm.mainnet_ca
FROM devnet_mints dm
WHERE m.mint_address = dm.devnet_mint
  AND m.mainnet_ca IS NULL;
