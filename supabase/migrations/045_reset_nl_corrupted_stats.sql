-- Migration 045: Reset corrupted NL market stats — GH#1208
-- Slab H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph has:
--   c_tot = 799773282469272000 (7.997e17 — just below the >1e18 sentinel threshold, corrupt)
--   open_interest_long = open_interest_short = 9006000000000 (suspect)
--   last_price = 4952 (admin-set garbage price — $4952 per devnet NL token)
-- Combined effect: total_open_interest_usd shows $89.2M on production.
-- Root cause: indexer wrote raw u64 values without decimal normalization.
-- Fix: zero out corrupted fields for this slab so indexer can re-populate from on-chain.

UPDATE market_stats
SET
  c_tot               = 0,
  open_interest_long  = 0,
  open_interest_short = 0,
  total_open_interest = 0,
  last_price          = 0,
  mark_price          = 0,
  vault_balance       = 0
WHERE slab_address = 'H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph';
