-- ============================================================================
-- 024_sim_price_history.sql
-- Simulator price history — no FK to markets (sim slabs aren't in markets table)
-- Oracle service writes here after each price push; TradingChart reads from it
-- ============================================================================

CREATE TABLE IF NOT EXISTS sim_price_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slab_address text NOT NULL,
  symbol text NOT NULL,
  price_e6 text NOT NULL,
  raw_price_e6 text,           -- pre-scenario price
  scenario_type text,           -- active scenario at time of push (null if none)
  timestamp bigint NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_sim_price_slab_ts ON sim_price_history(slab_address, timestamp DESC);
CREATE INDEX idx_sim_price_symbol_ts ON sim_price_history(symbol, timestamp DESC);

-- Cleanup: keep max 24h of data per slab (cron or service manages this)
-- For now, the oracle service will LIMIT inserts and the API will LIMIT reads

-- RLS
ALTER TABLE sim_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read sim prices" ON sim_price_history FOR SELECT USING (true);
CREATE POLICY "Service can manage sim prices" ON sim_price_history FOR ALL USING (true);
