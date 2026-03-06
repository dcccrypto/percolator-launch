-- #813: Add CHECK constraint to markets.oracle_mode
-- Ensures only valid oracle modes can be stored at DB level.
-- oracle_mode column already exists from migration 035.

ALTER TABLE markets
  ADD CONSTRAINT markets_oracle_mode_check
  CHECK (oracle_mode IN ('pyth', 'hyperp', 'admin'));
