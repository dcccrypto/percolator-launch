-- Migration 025: Fix USDC market decimals
-- 
-- Context: The indexer's auto-registration (StatsCollector.syncMarkets) used a
-- fallback of decimals=9 when it couldn't fetch on-chain mint info. Markets using
-- USDC as collateral (mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) should
-- have decimals=6 since USDC is a 6-decimal SPL token.
--
-- This caused the frontend to display incorrect Insurance Fund / vault values
-- (off by 10^3 = 1000x, showing ~$1T instead of ~$1B type errors).
--
-- This is a one-time fix. Going forward, the indexer reads decimals from on-chain
-- mint data at offset 44 (SPL Token Mint layout).

-- Fix all USDC-collateral markets to decimals=6
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

-- Log how many rows were affected (visible in migration output)
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
  
  RAISE NOTICE 'USDC markets with correct decimals=6: %', affected_count;
END $$;
