-- ============================================================================
-- 023_simulator_tables.sql
-- Percolator Risk Engine Simulator — Phase 1
-- Tables: faucet rate limiting, leaderboard, weekly archive, scenario voting
-- ============================================================================

-- Faucet rate limiting
CREATE TABLE sim_faucet_claims (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL,
  amount bigint NOT NULL,
  tx_signature text,
  claimed_at timestamptz DEFAULT now()
);
CREATE INDEX idx_sim_faucet_wallet ON sim_faucet_claims(wallet, claimed_at);

-- Simulator leaderboard
CREATE TABLE sim_leaderboard (
  wallet text PRIMARY KEY,
  display_name text,
  total_pnl bigint DEFAULT 0,
  total_deposited bigint DEFAULT 0,
  trade_count int DEFAULT 0,
  win_count int DEFAULT 0,
  liquidation_count int DEFAULT 0,
  best_trade bigint DEFAULT 0,
  worst_trade bigint DEFAULT 0,
  last_trade_at timestamptz,
  week_start timestamptz DEFAULT date_trunc('week', now()),
  updated_at timestamptz DEFAULT now()
);

-- Weekly archive
CREATE TABLE sim_leaderboard_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet text NOT NULL,
  week_start timestamptz NOT NULL,
  total_pnl bigint,
  trade_count int,
  rank int,
  archived_at timestamptz DEFAULT now()
);

-- Scenario voting
CREATE TABLE sim_scenarios (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  scenario_type text NOT NULL,
  proposed_by text NOT NULL,
  votes text[] DEFAULT '{}',
  vote_count int DEFAULT 0,
  status text DEFAULT 'voting',
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE sim_faucet_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_leaderboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_leaderboard_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sim_scenarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read leaderboard" ON sim_leaderboard FOR SELECT USING (true);
CREATE POLICY "Anyone can read history" ON sim_leaderboard_history FOR SELECT USING (true);
CREATE POLICY "Anyone can read scenarios" ON sim_scenarios FOR SELECT USING (true);
CREATE POLICY "Service can manage all" ON sim_faucet_claims FOR ALL USING (true);
CREATE POLICY "Service can manage leaderboard" ON sim_leaderboard FOR ALL USING (true);
CREATE POLICY "Service can manage scenarios" ON sim_scenarios FOR ALL USING (true);
