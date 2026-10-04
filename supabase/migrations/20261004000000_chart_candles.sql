-- Perp chart candles (mark / oracle series), written by the price-ws tick server and read by
-- /api/perp-chart/[slab]. See ~/percolator-ops/ledger/charts-perp-standard-plan-2026-10-04.md.
--
-- Additive and idempotent. Reached only over the direct Postgres connection
-- (INDEXER_DATABASE_URL); RLS is enabled with NO policies so PostgREST (anon / authenticated)
-- can neither read nor write it.

CREATE TABLE IF NOT EXISTS public.chart_candles (
  slab       text             NOT NULL,
  series     text             NOT NULL CHECK (series IN ('mark', 'oracle')),
  -- candle width in minutes: 1, 5, 15, 60, 240, 1440 (= 1D)
  res        smallint         NOT NULL CHECK (res IN (1, 5, 15, 60, 240, 1440)),
  -- bucket open time, unix seconds (UTC), aligned to `res`
  t          bigint           NOT NULL,
  o          double precision NOT NULL CHECK (o > 0),
  h          double precision NOT NULL CHECK (h > 0),
  l          double precision NOT NULL CHECK (l > 0),
  c          double precision NOT NULL CHECK (c > 0),
  -- observations folded into the candle (NOT a volume)
  n          integer          NOT NULL DEFAULT 0,
  -- 'live' = built from keeper ticks; 'gecko' = pre-launch backfill from GeckoTerminal
  src        text             NOT NULL DEFAULT 'live' CHECK (src IN ('live', 'gecko')),
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (slab, series, res, t)
);

-- Retention pruning scans by (res, t).
CREATE INDEX IF NOT EXISTS chart_candles_res_t_idx ON public.chart_candles (res, t);

ALTER TABLE public.chart_candles ENABLE ROW LEVEL SECURITY;

-- When did we last pull GeckoTerminal for (slab, res). CoinGecko terms require a cache refresh
-- at least every 24 h, and keyless access is burst-limited, so the pull is single-flight and
-- gated on this ledger.
CREATE TABLE IF NOT EXISTS public.chart_backfill (
  slab       text        NOT NULL,
  res        smallint    NOT NULL,
  fetched_at timestamptz NOT NULL,
  bars       integer     NOT NULL DEFAULT 0,
  -- Global single-flight + negative cache: a pull is claimed by setting this in the future (claim
  -- hold while pulling; 10 min back-off after a failed / no-pool / rate-limited pull). Shared by every
  -- instance through the database, so a new or unlisted market cannot retry-storm the shared IP.
  retry_after timestamptz,
  PRIMARY KEY (slab, res)
);

ALTER TABLE public.chart_backfill ENABLE ROW LEVEL SECURITY;
