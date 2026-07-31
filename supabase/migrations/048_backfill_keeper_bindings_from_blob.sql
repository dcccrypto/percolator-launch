-- 048: backfill the pool bindings the blob held and the DB never did.
--
-- Migration 047 made `markets` the source of truth for what the keeper prices,
-- but the market<->pool binding for every market registered through the OLD
-- path lived only in the Vercel blob (v17 has no on-chain feed_id, so the blob
-- was genuinely the only record). Cutting the keeper over to the DB without
-- copying those bindings across dropped those markets from the registry: their
-- rows had dex_pool_address = NULL and keeper_status = 'retired', so the
-- keeper's query skipped them and the trade page showed "MARKET CRANK BEHIND".
--
-- Values taken verbatim from GET /api/playground/registered-markets, which is
-- the record of what was actually registered. Symbols come from the same place
-- rather than being invented — these rows currently read 'UNKNOWN' because the
-- indexer created them.
--
-- Guarded: only fills a NULL pool, so it can never clobber a binding that a
-- real registration has since written. Safe to re-run.
UPDATE markets SET
  dex_pool_address = '3FSz59tucUArnHJPXBUBFCsb1644NPTFt3i1ooQPiAdQ',
  symbol = CASE WHEN symbol = 'UNKNOWN' THEN 'Fauci' ELSE symbol END,
  keeper_status = 'active'
WHERE slab_address = '5sDvEs2Zwn42ESkAmQm6Ycvi1XC3X8zHhhTDX1FX3hT7'
  AND dex_pool_address IS NULL;

UPDATE markets SET
  dex_pool_address = 'GN9whJWrkgU8jBRpM5oa4iwSzYw1LivjB397DSyvbVG',
  symbol = CASE WHEN symbol = 'UNKNOWN' THEN 'ZERO' ELSE symbol END,
  name = CASE WHEN name LIKE 'Market %' THEN 'ZERO' ELSE name END,
  keeper_status = 'active'
WHERE slab_address = '5xRkBU83ogswJnjzqMb1a2M41NczMzyajSLvrVAsAG9Z'
  AND dex_pool_address IS NULL;
