-- Migration 009: Create funding_history table
CREATE TABLE IF NOT EXISTS funding_history (
  id BIGSERIAL PRIMARY KEY,
  market_slab TEXT NOT NULL REFERENCES market_stats(slab_address),
  slot BIGINT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rate_bps_per_slot NUMERIC NOT NULL DEFAULT 0,
  net_lp_pos NUMERIC NOT NULL DEFAULT 0,
  price_e6 NUMERIC NOT NULL DEFAULT 0,
  funding_index_qpb_e6 TEXT NOT NULL DEFAULT '0',
  UNIQUE(market_slab, slot)
);

CREATE INDEX IF NOT EXISTS idx_funding_history_market_time 
  ON funding_history(market_slab, timestamp DESC);
