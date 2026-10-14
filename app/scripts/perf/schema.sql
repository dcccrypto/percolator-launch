-- Minimal schema for the data-egress perf harness (app/scripts/perf). LOCAL THROWAWAY DB ONLY.
-- Column types copied from percolator-indexer supabase/migrations/20260726120000_v17_baseline.sql
-- (+ 20260726190000 metadata_source, launch 047 keeper_status) and launch
-- supabase/migrations/20261004000000_chart_candles.sql. Indexes: the ones the live project has
-- per those migrations (idx_trades_network / idx_trades_slab / BRIN).
DROP VIEW IF EXISTS markets_with_stats;
DROP TABLE IF EXISTS trades, market_stats, markets, chart_candles CASCADE;

CREATE TABLE markets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slab_address      TEXT        NOT NULL UNIQUE,
  mint_address      TEXT        NOT NULL,
  symbol            TEXT        NOT NULL DEFAULT 'UNKNOWN',
  name              TEXT        NOT NULL DEFAULT 'Unknown Token',
  decimals          INTEGER     NOT NULL DEFAULT 6,
  deployer          TEXT        NOT NULL,
  oracle_authority  TEXT,
  initial_price_e6  TEXT,
  max_leverage      INTEGER     DEFAULT 10,
  trading_fee_bps   INTEGER     DEFAULT 10,
  lp_collateral     TEXT,
  matcher_context   TEXT,
  logo_url          TEXT,
  mainnet_ca        TEXT,
  oracle_mode       TEXT        NOT NULL DEFAULT 'admin',
  dex_pool_address  TEXT,
  indexer_excluded  BOOLEAN     NOT NULL DEFAULT false,
  network           TEXT        NOT NULL DEFAULT 'devnet',
  status            TEXT        NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  metadata_source   TEXT        NOT NULL DEFAULT 'auto',
  keeper_status     TEXT        NOT NULL DEFAULT 'retired'
);
CREATE INDEX idx_markets_network_status ON markets(network, status);

CREATE TABLE market_stats (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slab_address     TEXT        NOT NULL UNIQUE REFERENCES markets(slab_address) ON DELETE CASCADE,
  volume_24h       NUMERIC     DEFAULT 0,
  volume_24h_usd   NUMERIC,
  trade_count_24h  INTEGER     DEFAULT 0,
  last_price       NUMERIC,
  network          TEXT        NOT NULL DEFAULT 'devnet',
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE trades (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slab_address   TEXT        NOT NULL REFERENCES markets(slab_address) ON DELETE CASCADE,
  trader         TEXT        NOT NULL,
  side           TEXT,
  size           NUMERIC,
  price          NUMERIC,
  fee            NUMERIC     DEFAULT 0,
  tx_signature   TEXT,
  asset_index    SMALLINT    NOT NULL DEFAULT 0,
  leg_index      SMALLINT    NOT NULL DEFAULT 0,
  is_liquidation BOOLEAN     NOT NULL DEFAULT false,
  network        TEXT        NOT NULL DEFAULT 'devnet',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_trades_sig_asset_leg ON trades(tx_signature, asset_index, leg_index) WHERE tx_signature IS NOT NULL;
CREATE INDEX idx_trades_slab           ON trades(slab_address, created_at DESC);
CREATE INDEX idx_trades_trader_created ON trades(trader, created_at DESC);
CREATE INDEX idx_trades_network        ON trades(network, slab_address, created_at DESC);
CREATE INDEX brin_trades_created_at    ON trades USING BRIN (created_at);

-- As live: m.* expanded when the view was (re)created on 2026-07-26, i.e. BEFORE keeper_status
-- existed, so the view does not expose keeper_status.
CREATE VIEW markets_with_stats AS
SELECT
  m.id, m.slab_address, m.mint_address, m.symbol, m.name, m.decimals, m.deployer, m.oracle_authority,
  m.initial_price_e6, m.max_leverage, m.trading_fee_bps, m.lp_collateral, m.matcher_context, m.logo_url,
  m.mainnet_ca, m.oracle_mode, m.dex_pool_address, m.indexer_excluded, m.network, m.status, m.created_at,
  m.updated_at, m.metadata_source,
  s.volume_24h, s.volume_24h_usd, s.trade_count_24h, s.last_price,
  s.updated_at AS stats_updated_at
FROM markets m
LEFT JOIN market_stats s ON m.slab_address = s.slab_address
WHERE COALESCE(m.indexer_excluded, false) = false
  AND m.status <> 'closed';

CREATE TABLE chart_candles (
  slab       text             NOT NULL,
  series     text             NOT NULL,
  res        smallint         NOT NULL,
  t          bigint           NOT NULL,
  o          double precision NOT NULL,
  h          double precision NOT NULL,
  l          double precision NOT NULL,
  c          double precision NOT NULL,
  n          integer          NOT NULL DEFAULT 0,
  src        text             NOT NULL DEFAULT 'live',
  updated_at timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (slab, series, res, t)
);
CREATE INDEX chart_candles_res_t_idx ON chart_candles (res, t);
