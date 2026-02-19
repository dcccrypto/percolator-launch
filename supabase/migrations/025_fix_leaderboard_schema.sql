-- ============================================================================
-- 025_fix_leaderboard_schema.sql
-- Fix leaderboard schema bugs:
-- 1. sim_leaderboard: wallet was sole PK — can't have per-week rows per wallet.
--    Change PK to composite (wallet, week_start).
-- 2. sim_leaderboard_history: missing 7 columns that the reset route inserts.
-- 3. sim_leaderboard: add missing created_at column.
-- ============================================================================

-- ── 1. Fix sim_leaderboard primary key ───────────────────────────────────────
-- Drop old PK constraint (wallet-only)
ALTER TABLE sim_leaderboard DROP CONSTRAINT IF EXISTS sim_leaderboard_pkey;

-- Add composite PK so each wallet can have one row per week
ALTER TABLE sim_leaderboard ADD PRIMARY KEY (wallet, week_start);

-- Add created_at (the update route tries to insert it)
ALTER TABLE sim_leaderboard ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- ── 2. Fix sim_leaderboard_history — add missing columns ─────────────────────
-- The reset route inserts: display_name, final_rank, total_deposited,
-- win_count, liquidation_count, best_trade, worst_trade
-- Existing columns:  id, wallet, week_start, total_pnl, trade_count, rank, archived_at

ALTER TABLE sim_leaderboard_history
  ADD COLUMN IF NOT EXISTS display_name      text,
  ADD COLUMN IF NOT EXISTS final_rank        int,        -- the reset route uses "final_rank"
  ADD COLUMN IF NOT EXISTS total_deposited   bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS win_count         int    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidation_count int    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_trade        bigint,
  ADD COLUMN IF NOT EXISTS worst_trade       bigint;

-- Keep existing "rank" column for backwards compat — reset route uses "final_rank"
-- so no need to rename the old "rank" column.

COMMENT ON TABLE sim_leaderboard IS 'Weekly simulator leaderboard — one row per (wallet, week_start)';
COMMENT ON COLUMN sim_leaderboard.week_start IS 'ISO Monday 00:00 UTC of the current week';
COMMENT ON TABLE sim_leaderboard_history IS 'Archived weekly leaderboard snapshots with final rankings';
