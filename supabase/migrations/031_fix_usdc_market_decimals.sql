-- Migration 031: Fix USDC market decimals (idempotent re-apply guard)
--
-- HISTORY: This SQL was originally applied to prod as migration 025
-- (025_fix_usdc_market_decimals.sql). That file was renamed to 031 in PR #687
-- when 025 was already occupied by 025_cleanup_corrupt_insurance.sql.
-- Supabase will now attempt to run this as a new migration — it is SAFE to
-- re-apply because both UPDATE statements include `AND decimals != 6` guards,
-- making them no-ops if the fix is already in place.
--
-- Context: The indexer's auto-registration (StatsCollector.syncMarkets) used a
-- fallback of decimals=9 when it couldn't fetch on-chain mint info. Markets using
-- USDC as collateral (mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) should
-- have decimals=6 since USDC is a 6-decimal SPL token.
--
-- This caused the frontend to display incorrect Insurance Fund / vault values
-- (off by 10^3 = 1000x, showing ~$1T instead of ~$1B type errors).
--
-- This is safe to re-run: WHERE decimals != 6 ensures rows already fixed are skipped.

-- Fix all USDC-collateral markets to decimals=6 (no-op if already correct)
UPDATE markets
SET decimals = 6,
    updated_at = NOW()
WHERE mint_address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND decimals != 6;

-- Also fix devnet USDC variants (common devnet faucet mints)
-- Devnet USDC: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
UPDATE markets
SET decimals = 6,
    updated_at = NOW()
WHERE mint_address = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  AND decimals != 6;

-- Log how many rows have correct decimals=6 (0 updated = already fixed = expected on re-run)
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected_count
  FROM markets
  WHERE mint_address IN (
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  ) AND decimals = 6;

  RAISE NOTICE 'Migration 031: USDC markets with correct decimals=6: % (0 rows updated = already applied as 025, which is expected)', affected_count;
END $$;
