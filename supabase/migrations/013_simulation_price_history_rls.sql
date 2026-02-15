-- Migration 013: Add RLS to simulation_price_history
-- This table was created in migration 011 but RLS was not enabled

ALTER TABLE simulation_price_history ENABLE ROW LEVEL SECURITY;

-- Public read access (simulation data is public)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Public read simulation_price_history') THEN
    CREATE POLICY "Public read simulation_price_history" ON simulation_price_history FOR SELECT USING (true);
  END IF;
END $$;

-- Service role write only
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Service write simulation_price_history') THEN
    CREATE POLICY "Service write simulation_price_history" ON simulation_price_history FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
