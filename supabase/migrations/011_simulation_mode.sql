-- Simulation Mode Tables
-- Tracks simulation sessions and price history for testing and development

-- Simulation Sessions
-- Each simulation run gets a session record
CREATE TABLE IF NOT EXISTS simulation_sessions (
  id BIGSERIAL PRIMARY KEY,
  slab_address TEXT NOT NULL,
  scenario TEXT,  -- calm, bull, crash, squeeze, whale, blackswan, or NULL for custom
  model TEXT NOT NULL,  -- random-walk, mean-revert, trending, crash, squeeze
  start_price_e6 BIGINT NOT NULL,
  current_price_e6 BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'completed')),
  updates_count INT DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  config JSONB DEFAULT '{}'  -- Model parameters and other config
);

-- Index for querying sessions by slab
CREATE INDEX IF NOT EXISTS idx_simulation_sessions_slab 
  ON simulation_sessions(slab_address, started_at DESC);

-- Index for querying active sessions
CREATE INDEX IF NOT EXISTS idx_simulation_sessions_status 
  ON simulation_sessions(status, started_at DESC);

-- Simulation Price History
-- Records every price update during a simulation
CREATE TABLE IF NOT EXISTS simulation_price_history (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES simulation_sessions(id) ON DELETE CASCADE,
  slab_address TEXT NOT NULL,
  price_e6 BIGINT NOT NULL,
  model TEXT NOT NULL,  -- Model that generated this price
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying price history by session
CREATE INDEX IF NOT EXISTS idx_sim_price_history_session 
  ON simulation_price_history(session_id, timestamp DESC);

-- Index for querying price history by slab
CREATE INDEX IF NOT EXISTS idx_sim_price_history_slab 
  ON simulation_price_history(slab_address, timestamp DESC);

-- Comments for documentation
COMMENT ON TABLE simulation_sessions IS 'Tracks simulation test sessions with different price models and scenarios';
COMMENT ON TABLE simulation_price_history IS 'Records all price updates during simulation sessions for analysis';
COMMENT ON COLUMN simulation_sessions.scenario IS 'Predefined scenario name (calm, bull, crash, squeeze, whale, blackswan) or NULL for custom';
COMMENT ON COLUMN simulation_sessions.model IS 'Price model used: random-walk, mean-revert, trending, crash, or squeeze';
COMMENT ON COLUMN simulation_sessions.config IS 'JSON object with model parameters (volatility, revertSpeed, etc.)';
