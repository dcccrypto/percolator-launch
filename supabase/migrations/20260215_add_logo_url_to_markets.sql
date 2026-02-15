-- Add logo_url column to markets table for storing market/token logos
-- Logo can be a URL to Supabase Storage, IPFS, or any public image URL

ALTER TABLE markets 
ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- Add index for faster queries when filtering by markets with logos
CREATE INDEX IF NOT EXISTS idx_markets_logo_url ON markets(logo_url) WHERE logo_url IS NOT NULL;

-- Update the markets_with_stats view to include logo_url
DROP VIEW IF EXISTS markets_with_stats;
CREATE VIEW markets_with_stats AS
SELECT 
  m.id,
  m.slab_address,
  m.mint_address,
  m.symbol,
  m.name,
  m.decimals,
  m.deployer,
  m.oracle_authority,
  m.initial_price_e6,
  m.max_leverage,
  m.trading_fee_bps,
  m.lp_collateral,
  m.matcher_context,
  m.logo_url,
  m.created_at,
  m.updated_at,
  s.last_price,
  s.price_change_24h,
  s.volume_24h,
  s.open_interest,
  s.num_traders,
  s.vault_balance,
  s.insurance_balance,
  s.last_crank_slot,
  s.updated_at as stats_updated_at
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address;

COMMENT ON COLUMN markets.logo_url IS 'URL to market/token logo image. Can be Supabase Storage, IPFS, or external URL.';
