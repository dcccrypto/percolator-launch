-- Production-shaped seed for the perf harness. LOCAL THROWAWAY DB ONLY.
-- 86 old-wrapper rows (closed on 2026-10-01, deployments.md) + 15 live markets, one of them idle.
-- ~200k trades over 45 days on the 14 trading slabs: 3 busy slabs carry ~70%.
-- psql -v old_status=closed (default) | active  (models a live view/status that still lists them)
\set ON_ERROR_STOP on
\if :{?old_status}
\else
  \set old_status closed
\endif
SELECT setseed(0.42);

-- A real base58 pubkey (32 bytes = sha256 of the seed text), so routes that validate slab
-- addresses (PublicKey) accept them.
CREATE OR REPLACE FUNCTION pg_temp.addr(prefix text, i int) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  alphabet constant text := '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  b bytea := sha256(convert_to(prefix || i::text, 'UTF8'));
  n numeric := 0;
  out text := '';
  k int;
BEGIN
  FOR k IN 0 .. length(b) - 1 LOOP
    n := n * 256 + get_byte(b, k);
  END LOOP;
  WHILE n > 0 LOOP
    out := substr(alphabet, (mod(n, 58))::int + 1, 1) || out;
    n := div(n, 58);
  END LOOP;
  FOR k IN 0 .. length(b) - 1 LOOP
    EXIT WHEN get_byte(b, k) <> 0;
    out := '1' || out;
  END LOOP;
  RETURN out;
END $$;

INSERT INTO markets (slab_address, mint_address, symbol, name, decimals, deployer, oracle_authority, logo_url,
                     mainnet_ca, oracle_mode, dex_pool_address, status, keeper_status, metadata_source, created_at)
SELECT pg_temp.addr('Old', i), pg_temp.addr('Mint', i), 'OLD' || i, 'Old market ' || i, 6, pg_temp.addr('Dep', i),
       pg_temp.addr('Auth', i), 'https://ntcnkipyzrshoejssvbd.supabase.co/storage/v1/object/public/logos/' || pg_temp.addr('Old', i) || '.png',
       pg_temp.addr('Ca', i), 'admin', pg_temp.addr('Pool', i), :'old_status', 'retired', 'manual',
       now() - interval '60 days' + i * interval '3 hours'
  FROM generate_series(1, 86) i;

INSERT INTO markets (slab_address, mint_address, symbol, name, decimals, deployer, oracle_authority, logo_url,
                     mainnet_ca, oracle_mode, dex_pool_address, status, keeper_status, metadata_source, created_at)
SELECT pg_temp.addr('Live', i), 'DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC', 'TOK' || i, 'Live token ' || i, 6,
       pg_temp.addr('Dep', 100 + i), pg_temp.addr('Auth', 100 + i),
       'https://ntcnkipyzrshoejssvbd.supabase.co/storage/v1/object/public/logos/' || pg_temp.addr('Live', i) || '.png',
       pg_temp.addr('Ca', 100 + i), 'admin', pg_temp.addr('Pool', 100 + i), 'active', 'active', 'auto',
       now() - interval '13 days' + i * interval '1 hour'
  FROM generate_series(1, 15) i;

INSERT INTO market_stats (slab_address, volume_24h, volume_24h_usd, trade_count_24h, last_price)
SELECT slab_address, round((random() * 1e12)::numeric), round((random() * 1e5)::numeric, 2), (random() * 500)::int, round((random() * 200)::numeric, 6)
  FROM markets;

-- Trades: slab weights. Live1..3 busy (70%), Live4..14 the rest, Live15 idle (no trades).
WITH w AS (
  SELECT g AS n,
         CASE WHEN r < 0.70 THEN 1 + (g % 3) ELSE 4 + (g % 11) END AS slab_i,
         now() - (random() * interval '45 days') AS ts
    FROM (SELECT g, random() AS r FROM generate_series(1, 200000) g) s
)
INSERT INTO trades (slab_address, trader, side, size, price, fee, tx_signature, asset_index, leg_index, created_at)
SELECT pg_temp.addr('Live', slab_i), pg_temp.addr('Trader', n % 400),
       CASE WHEN n % 2 = 0 THEN 'long' ELSE 'short' END,
       round((random() * 5e9)::numeric), round((50 + random() * 150)::numeric, 6), round((random() * 1e4)::numeric),
       pg_temp.addr('Sig', n) || pg_temp.addr('Sig2', n), 0, 0, ts
  FROM w;

-- A few liquidation markers (null price/size/side), as the indexer writes them.
INSERT INTO trades (slab_address, trader, is_liquidation, created_at)
SELECT pg_temp.addr('Live', 1 + (g % 14)), pg_temp.addr('Trader', g), true, now() - random() * interval '45 days'
  FROM generate_series(1, 300) g;

ANALYZE;
SELECT (SELECT count(*) FROM markets) AS markets, (SELECT count(*) FROM markets_with_stats) AS view_rows,
       (SELECT count(*) FROM trades) AS trades;
