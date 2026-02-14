# Migration 007 Deployment Report
**Date**: 2026-02-14 18:20 UTC  
**Project**: ygvbajglkrwkbjdjyhxi  
**Migration**: 007_hidden_features.sql  
**Status**: ✅ SUCCESS

## Deployment Summary

Migration 007 was successfully deployed to Supabase production database.

### Tables Created ✅
1. **insurance_history** - Time-series tracking of insurance fund balance and fee revenue
   - Columns: id, market_slab, slot, timestamp, balance, fee_revenue
   - Indexes: idx_insurance_history_slab_time, idx_insurance_history_slab_slot
   - Constraint: UNIQUE(market_slab, slot)

2. **oi_history** - Time-series tracking of open interest and LP metrics
   - Columns: id, market_slab, slot, timestamp, total_oi, net_lp_pos, lp_sum_abs, lp_max_abs
   - Indexes: idx_oi_history_slab_time, idx_oi_history_slab_slot
   - Constraint: UNIQUE(market_slab, slot)

### Views Created ✅
1. **insurance_fund_health** - Insurance fund metrics with health ratio
   - Fields: slab_address, insurance_balance, insurance_fee_revenue, total_open_interest, health_ratio, fee_growth_24h

2. **oi_imbalance** - Open interest breakdown with long/short split
   - Fields: slab_address, total_open_interest, net_lp_pos, lp_sum_abs, lp_max_abs, long_oi, short_oi, imbalance_percent

### Market Stats Extended ✅
Added 7 new columns to `market_stats` table:
1. `warmup_period_slots` (BIGINT) - PNL warmup period in slots
2. `total_open_interest` (NUMERIC) - Sum of abs(position_size) across all accounts
3. `net_lp_pos` (NUMERIC) - Net LP position (sum of LP position_size, signed)
4. `lp_sum_abs` (NUMERIC) - Sum of abs(position_size) for LP accounts only
5. `lp_max_abs` (NUMERIC) - Maximum abs(position_size) among LP accounts
6. `insurance_balance` (NUMERIC) - Insurance fund balance
7. `insurance_fee_revenue` (NUMERIC) - Accumulated fees in insurance fund

## Verification Results

All schema changes verified via REST API:
- ✅ Tables accessible and queryable
- ✅ Views accessible and returning data structure
- ✅ All 7 columns added to market_stats
- ✅ No errors or warnings during deployment

## Migration Process

The migration was deployed using the Supabase CLI:
```bash
supabase link --project-ref ygvbajglkrwkbjdjyhxi
supabase db push --linked
```

## Notes & Warnings

⚠️ **Migration 006 Conflict**: Migration 006 (funding_rates.sql) was temporarily skipped during deployment due to schema conflicts with the production database. The production schema does not contain all columns expected by migration 006 (e.g., `price_change_24h`, `open_interest`). Migration 006 will need to be aligned with the actual production schema before it can be safely applied.

## Function Created ✅
- `cleanup_old_history(days_to_keep INTEGER)` - Delete history records older than specified days (default 30)

## Next Steps

1. ✅ Migration 007 deployed successfully
2. 🔄 Populate new columns via backend data pipeline
3. 🔄 Test insurance_fund_health and oi_imbalance views with real data
4. ⚠️ Review and fix migration 006 schema conflicts before reapplying
5. 📊 Monitor new tables and views for data population
