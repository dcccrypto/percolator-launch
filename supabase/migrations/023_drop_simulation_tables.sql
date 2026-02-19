-- Migration 023: Drop simulation tables
-- The simulator feature was removed in PRs #225-#227 (2026-02-19).
-- Migrations 011-013 created these tables but the migration files were
-- deleted. This migration ensures the tables are cleaned up in any
-- environment where they still exist.

DROP TABLE IF EXISTS simulation_price_history CASCADE;
DROP TABLE IF EXISTS simulation_sessions CASCADE;

-- Drop related indexes (CASCADE above handles most, but be explicit)
DROP INDEX IF EXISTS idx_simulation_sessions_slab;
DROP INDEX IF EXISTS idx_simulation_sessions_status;
DROP INDEX IF EXISTS idx_sim_price_history_session;
DROP INDEX IF EXISTS idx_sim_price_history_slab;
