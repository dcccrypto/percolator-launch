-- BH8: Add unique constraint on tx_signature to prevent duplicate trade inserts
-- This prevents the TradeIndexer from inserting the same trade multiple times

-- First, remove any existing duplicates (keep the oldest record for each signature)
DELETE FROM trades
WHERE id NOT IN (
  SELECT MIN(id)
  FROM trades
  WHERE tx_signature IS NOT NULL
  GROUP BY tx_signature
);

-- Add unique constraint on tx_signature (allows NULL values)
ALTER TABLE trades
ADD CONSTRAINT trades_tx_signature_unique UNIQUE (tx_signature);

-- Add index for faster signature lookups (improves tradeExistsBySignature query)
CREATE INDEX IF NOT EXISTS idx_trades_tx_signature ON trades(tx_signature)
WHERE tx_signature IS NOT NULL;
