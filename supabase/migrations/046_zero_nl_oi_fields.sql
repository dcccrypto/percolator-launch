-- Migration 046: Zero NL slab OI fields + add indexer-exclusion flag — GH#1218
--
-- Context: Migration 045 zeroed corrupted NL slab stats but the indexer subsequently
-- re-synced open_interest_long/short/total_open_interest from the on-chain state
-- (which contains corrupt raw u64 values: 9006000000000 ≈ 9e12 per side → $89.2M OI).
--
-- The c_tot guard (sanitizeCtot from PR #1212) correctly nulled c_tot at the API layer,
-- but the OI fields were NOT sanitized — they pass isSaneMarketValue (9e12 < 1e18).
--
-- Fix:
--   1. Zero the OI columns again for NL slab in market_stats.
--   2. Add markets.indexer_excluded boolean column to let the indexer skip writing
--      stats for permanently-corrupted slabs.
--   3. Mark the NL slab as indexer_excluded = true.
--
-- API-level: the NL slab is also added to BLOCKED_SLAB_ADDRESSES in blocklist.ts
-- so /api/markets and /api/stats both exclude it regardless of indexer state.

-- Step 1: Zero OI fields for NL slab
UPDATE market_stats
SET
  open_interest_long  = 0,
  open_interest_short = 0,
  total_open_interest = 0
WHERE slab_address = 'H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph';

-- Step 2: Add indexer_excluded column to markets table (if not exists)
ALTER TABLE markets
  ADD COLUMN IF NOT EXISTS indexer_excluded boolean NOT NULL DEFAULT false;

-- Step 3: Mark NL slab as excluded from indexer writes
UPDATE markets
SET indexer_excluded = true
WHERE slab_address = 'H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph';

-- Note: indexer code must be updated to respect this flag (check indexer_excluded before
-- writing market_stats for a slab). This migration adds the schema; the indexer change
-- is a separate PR to prevent re-population of corrupt on-chain state.
