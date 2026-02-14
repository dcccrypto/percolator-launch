-- Hidden Features Database Validation Script
-- Tests schema changes and data integrity for migration 007

\echo '\n=== Migration 007 Schema Validation ==='

-- Check if new columns exist in market_stats
\echo '\nChecking market_stats new columns...'
SELECT 
    column_name, 
    data_type,
    is_nullable
FROM information_schema.columns 
WHERE table_name = 'market_stats' 
  AND column_name IN (
    'warmup_period_slots',
    'total_open_interest', 
    'net_lp_pos',
    'insurance_balance',
    'insurance_fee_revenue'
  )
ORDER BY column_name;

\echo '\nExpected: 5 rows (warmup_period_slots, total_open_interest, net_lp_pos, insurance_balance, insurance_fee_revenue)'

-- Check if new tables exist
\echo '\n=== New Tables Check ==='

SELECT 
    table_name,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
FROM information_schema.tables t
WHERE table_name IN ('insurance_history', 'oi_history')
ORDER BY table_name;

\echo '\nExpected: 2 tables (insurance_history, oi_history)'

-- Check insurance_history schema
\echo '\n=== insurance_history Schema ==='
SELECT 
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'insurance_history'
ORDER BY ordinal_position;

-- Check oi_history schema
\echo '\n=== oi_history Schema ==='
SELECT 
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'oi_history'
ORDER BY ordinal_position;

-- Check indexes
\echo '\n=== Indexes Check ==='
SELECT 
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('insurance_history', 'oi_history')
ORDER BY tablename, indexname;

-- Data integrity checks
\echo '\n=== Data Integrity Checks ==='

-- Check for NULL values in critical fields
\echo '\nChecking for NULL values in market_stats...'
SELECT 
    COUNT(*) as total_markets,
    COUNT(warmup_period_slots) as has_warmup,
    COUNT(total_open_interest) as has_oi,
    COUNT(insurance_balance) as has_insurance
FROM market_stats;

-- Check insurance_history data
\echo '\nChecking insurance_history data...'
SELECT 
    COUNT(*) as total_records,
    COUNT(DISTINCT slab_address) as unique_markets,
    MIN(timestamp) as earliest_record,
    MAX(timestamp) as latest_record
FROM insurance_history;

-- Check oi_history data
\echo '\nChecking oi_history data...'
SELECT 
    COUNT(*) as total_records,
    COUNT(DISTINCT slab_address) as unique_markets,
    MIN(timestamp) as earliest_record,
    MAX(timestamp) as latest_record
FROM oi_history;

-- Sample recent insurance history
\echo '\n=== Recent Insurance History (Last 5 records) ==='
SELECT 
    slab_address,
    balance,
    fee_revenue,
    timestamp
FROM insurance_history
ORDER BY timestamp DESC
LIMIT 5;

-- Sample recent OI history
\echo '\n=== Recent OI History (Last 5 records) ==='
SELECT 
    slab_address,
    total_oi,
    long_oi,
    short_oi,
    net_lp_pos,
    timestamp
FROM oi_history
ORDER BY timestamp DESC
LIMIT 5;

-- Validate OI math consistency
\echo '\n=== OI Math Validation ==='
SELECT 
    slab_address,
    total_oi,
    long_oi,
    short_oi,
    (long_oi + short_oi) as calculated_total,
    CASE 
        WHEN total_oi = (long_oi + short_oi) THEN 'OK'
        ELSE 'MISMATCH'
    END as status
FROM oi_history
WHERE timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 10;

-- Check for negative values (should not exist)
\echo '\n=== Negative Value Check (Should be empty) ==='
SELECT 
    slab_address,
    balance,
    fee_revenue,
    timestamp
FROM insurance_history
WHERE balance < 0 OR fee_revenue < 0
LIMIT 5;

-- Performance check: Index usage
\echo '\n=== Index Performance Check ==='
EXPLAIN ANALYZE
SELECT * FROM insurance_history 
WHERE slab_address = 'ErVCYKHbVLV2zN6Ss5gvPPQx5SbhYKb5AzKdYqiJx4qe'
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC
LIMIT 100;

-- Foreign key constraints check
\echo '\n=== Foreign Key Constraints ==='
SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('insurance_history', 'oi_history');

-- Data growth check (last 24h)
\echo '\n=== Data Growth Check (Last 24h) ==='
SELECT 
    'insurance_history' as table_name,
    COUNT(*) as records_last_24h,
    COUNT(DISTINCT slab_address) as active_markets
FROM insurance_history
WHERE timestamp > NOW() - INTERVAL '24 hours'

UNION ALL

SELECT 
    'oi_history' as table_name,
    COUNT(*) as records_last_24h,
    COUNT(DISTINCT slab_address) as active_markets
FROM oi_history
WHERE timestamp > NOW() - INTERVAL '24 hours';

\echo '\n=== Validation Complete ==='
