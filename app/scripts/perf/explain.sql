-- EXPLAIN for the two new hot queries on the seeded local DB (app/scripts/perf). LOCAL ONLY.
-- E1 trade feed: 4 watched slabs (2 busy, 1 normal, 1 idle), cursors at now - 15 s.
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT t.id::text AS id, t.slab_address, t.price::text AS price, t.size::text AS size, t.side, t.created_at,
       (extract(epoch FROM t.created_at) * 1000000)::bigint::text AS cursor_us
  FROM unnest((SELECT array_agg(slab_address ORDER BY slab_address) FROM markets WHERE symbol IN ('TOK1','TOK2','TOK5','TOK15')),
              (SELECT array_agg(((extract(epoch FROM now()) - 15) * 1000000)::bigint) FROM generate_series(1,4)),
              (SELECT array_agg('00000000-0000-0000-0000-000000000000'::uuid) FROM generate_series(1,4))) AS c(slab, after_us, after_id)
  CROSS JOIN LATERAL (
    SELECT id, slab_address, price, size, side, created_at FROM trades
     WHERE network = 'devnet' AND slab_address = c.slab
       AND created_at >= timestamptz 'epoch' + c.after_us * interval '1 microsecond'
       AND (created_at, id) > (timestamptz 'epoch' + c.after_us * interval '1 microsecond', c.after_id)
     ORDER BY created_at DESC, id DESC LIMIT 100) t;

-- E3 candles: busy slab, 1h buckets, 45 days.
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT t, o, h, l, c, v FROM (
  SELECT (floor(extract(epoch FROM created_at))::bigint / 3600) * 3600 AS t,
         ((array_agg(price ORDER BY created_at, id))[1])::text AS o, max(price)::text AS h, min(price)::text AS l,
         ((array_agg(price ORDER BY created_at DESC, id DESC))[1])::text AS c, coalesce(sum(abs(size)), 0)::text AS v
    FROM trades
   WHERE slab_address = (SELECT slab_address FROM markets WHERE symbol = 'TOK1') AND network = 'devnet'
     AND created_at >= now() - interval '45 days' AND created_at < now() + interval '1 hour'
     AND price IS NOT NULL AND price > 0 AND price < 'Infinity'::numeric
     AND (size IS NULL OR abs(size) < 'Infinity'::numeric)
   GROUP BY 1 ORDER BY 1 DESC LIMIT 10000) b ORDER BY t;
