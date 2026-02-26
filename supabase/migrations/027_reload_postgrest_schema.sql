-- Migration 027: Force PostgREST schema cache reload
-- 
-- Context: Migration 024 dropped and recreated the markets_with_stats view
-- with column type changes (BIGINT → NUMERIC). PostgREST caches the schema
-- and may serve stale metadata, causing "Cannot coerce the result to a single
-- JSON object" errors on .single() queries against the view.
--
-- This NOTIFY forces PostgREST to reload its schema cache immediately.

NOTIFY pgrst, 'reload schema';
