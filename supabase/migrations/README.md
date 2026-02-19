# Percolator Launch — Database Migrations

This directory contains all database schema migrations for the Percolator perpetual futures exchange platform.

## Running Migrations

### Locally (Supabase CLI)
```bash
# Start local Supabase
supabase start

# Apply all migrations
supabase db reset

# Or apply specific migration
supabase migration up
```

### Production
Migrations are automatically applied when pushed to the linked Supabase project via the CLI or GitHub integration.

## Migration History

| # | File | Description |
|---|------|-------------|
| 001 | `initial_schema.sql` | Core schema: markets, market_stats, trades, oracle_prices, markets_with_stats view |
| 002 | `insurance_lp.sql` | Insurance and LP tracking tables |
| 003 | `trade_signature_unique.sql` | Add unique constraint on `trades.tx_signature` to prevent duplicates |
| 004 | `bug_report_status_values.sql` | Extend bug_reports status enum with 'unpaid', 'paid', 'invalid' |
| 005 | `market_stats_schema_update.sql` | Align market_stats with StatsCollector writes (add missing columns) |
| 006 | `bug_reports.sql` | Bug reports table with severity, status, bounty tracking |
| 007 | `hidden_features.sql` | Hidden transparency features: PNL warmup, insurance fund, open interest, creates insurance_history and oi_history tables |
| 008 | `update_markets_with_stats_view.sql` | Update markets_with_stats view to include hidden features columns |
| 009 | `funding_history_table.sql` | Funding rate history tracking table |
| 010 | `complete_risk_engine_fields.sql` | Add ALL missing RiskEngine fields to market_stats (vault_balance, liquidation params, crank staleness, etc.) |
| 011 | `simulation_mode.sql` | Simulation mode: simulation_sessions and simulation_price_history tables |
| 012 | `simulation_results.sql` | Enhanced simulation tracking with result stats, token info, wallet tracking, and gallery view |
| 013 | `simulation_price_history_rls.sql` | Enable RLS on simulation_price_history table |
| 014 | `add_logo_url.sql` | Add logo_url column to markets table |
| 015 | `admin_rls.sql` | Enable RLS on bug_reports table |
| 016 | `admin_users.sql` | Admin users whitelist table |
| 017 | `fix_status_constraint.sql` | Fix bug_reports status constraint to include all valid statuses |
| 018 | `performance_indexes.sql` | Performance indexes for common query patterns (funding, trades, oracle prices, etc.) |
| 019 | `ideas_table.sql` | User-submitted feature ideas and feedback table |
| 020 | `job_applications_table.sql` | Beta tester and team member applications with CV uploads |
| 021 | `fix_rls_policies.sql` | Fix write policies to require service_role (was open to anon) |
| 022 | `insurance_tables.sql` | Insurance snapshots and LP events tables |
| 023 | `drop_simulation_tables.sql` | Drop simulation tables (feature removed in PRs #225-#227) |

## Database Schema Overview

### Core Tables

#### `markets`
Registered on-chain perpetual markets with metadata
- **PK:** `id` (UUID)
- **Unique:** `slab_address` (on-chain market account)
- **Key fields:** mint_address, symbol, name, decimals, deployer, oracle_authority, logo_url

#### `market_stats`
Latest on-chain statistics for each market (updated by crank/indexer)
- **PK:** `id` (UUID)
- **Unique FK:** `slab_address` → markets
- **Key fields:** last_price, mark_price, index_price, volume_24h, open_interest_long/short, insurance_fund, funding_rate, vault_balance, liquidation params, PNL warmup, total_open_interest, net_lp_pos, insurance_balance

#### `trades`
Trade history (populated by TradeIndexer)
- **PK:** `id` (UUID)
- **FK:** `slab_address` → markets
- **Unique:** `tx_signature`
- **Key fields:** trader, side, size, price, fee, timestamp

#### `oracle_prices`
Historical oracle price data
- **PK:** `id` (UUID)
- **FK:** `slab_address` → markets
- **Key fields:** price_e6, source, timestamp, slot

#### `funding_history`
Funding rate history over time
- **PK:** `id` (BIGSERIAL)
- **FK:** `market_slab` → market_stats
- **Key fields:** rate_bps_per_slot, timestamp, slot

### Transparency & Analytics Tables

#### `insurance_history`
Time-series tracking of insurance fund balance and fee revenue
- **PK:** `id` (BIGSERIAL)
- **FK:** `market_slab` → market_stats
- **Unique:** (market_slab, slot)
- **Key fields:** balance, fee_revenue, slot, timestamp

#### `oi_history`
Time-series tracking of open interest and LP aggregate metrics
- **PK:** `id` (BIGSERIAL)
- **FK:** `market_slab` → market_stats
- **Unique:** (market_slab, slot)
- **Key fields:** total_oi, net_lp_pos, lp_sum_abs, lp_max_abs, slot, timestamp

### User-Generated Content Tables

#### `bug_reports`
Bug reports with bounty tracking
- **PK:** `id` (UUID)
- **Key fields:** twitter_handle, title, description, severity, status, bounty_wallet, browser, ip, admin_notes

#### `ideas`
User-submitted feature ideas and feedback
- **PK:** `id` (UUID)
- **Key fields:** handle, idea, contact, status, admin_notes

#### `job_applications`
Beta tester and team member applications
- **PK:** `id` (UUID)
- **Key fields:** name, twitter_handle, email, desired_role, experience_level, about, portfolio_links, cv_data, availability, status

### Admin Tables

#### `admin_users`
Whitelist of emails allowed admin access
- **PK:** `id` (UUID)
- **Unique:** `email`
- **Key fields:** email, role, created_at

### Views

#### `markets_with_stats`
Combined view of markets with their latest stats (includes all fields from market_stats joined with markets)

#### `insurance_fund_health`
Insurance fund metrics with health ratio and accumulation rate

#### `oi_imbalance`
Open interest breakdown with long/short split and imbalance metrics

## Performance Indexes

Key indexes for optimal query performance:

```sql
-- Markets
idx_markets_mint ON markets(mint_address)
idx_markets_deployer ON markets(deployer)

-- Trades
idx_trades_slab ON trades(slab_address, created_at DESC)
idx_trades_market_time ON trades(slab_address, timestamp DESC)
idx_trades_signature ON trades(tx_signature) -- Unique constraint

-- Oracle Prices
idx_oracle_prices_slab ON oracle_prices(slab_address, timestamp DESC)
idx_oracle_prices_market_time ON oracle_prices(slab_address, timestamp DESC)

-- Funding History
idx_funding_history_market_time ON funding_history(market_slab, timestamp DESC)

-- Insurance History
idx_insurance_history_slab_time ON insurance_history(market_slab, timestamp DESC)
idx_insurance_history_slab_slot ON insurance_history(market_slab, slot DESC)

-- OI History
idx_oi_history_slab_time ON oi_history(market_slab, timestamp DESC)
idx_oi_history_slab_slot ON oi_history(market_slab, slot DESC)

-- Bug Reports
idx_bug_reports_status ON bug_reports(status)
idx_bug_reports_severity ON bug_reports(severity)
idx_bug_reports_created ON bug_reports(created_at DESC)
idx_bug_reports_handle ON bug_reports(twitter_handle)

-- Ideas
idx_ideas_status ON ideas(status)
idx_ideas_created ON ideas(created_at DESC)

-- Job Applications
idx_applications_status ON job_applications(status)
idx_applications_role ON job_applications(desired_role)
idx_applications_created ON job_applications(created_at DESC)
idx_applications_twitter ON job_applications(twitter_handle)
```

## Row-Level Security (RLS)

All tables have RLS enabled with the following policy pattern:
- **Public read:** All users can SELECT (some sensitive fields may be filtered in application layer)
- **Public write:** Users can INSERT on user-generated content tables (bug_reports, ideas, job_applications)
- **Service role:** Service key (backend) has full UPDATE/DELETE access

Admin-only operations are handled via service role key on the backend.

## Helper Functions

### `update_updated_at()`
Trigger function to automatically update `updated_at` timestamp on UPDATE.
Used by: bug_reports, ideas, job_applications

### `cleanup_old_history(days_to_keep INTEGER DEFAULT 30)`
Delete history records older than specified days (default 30).
Returns: (insurance_deleted, oi_deleted)

## Schema Versioning

Current schema version: **023** (as of 2026-02-19)

Migrations are applied sequentially and should NEVER be modified after being deployed to production.
New schema changes must be added as new migration files with the next sequential number.

## Development Workflow

1. **Create new migration:**
   ```bash
   supabase migration new descriptive_name
   ```

2. **Write SQL changes** in the generated file

3. **Test locally:**
   ```bash
   supabase db reset  # Applies all migrations from scratch
   ```

4. **Push to production:**
   ```bash
   supabase db push
   ```

## Troubleshooting

### "Relation does not exist" errors
- Ensure migrations are applied in order
- Check that foreign key references exist
- Run `supabase db reset` locally to start fresh

### Duplicate key violations
- Check for unique constraints (tx_signature, email, etc.)
- Review RLS policies if using service role key

### View definition errors
- Ensure all referenced columns exist in underlying tables
- Drop and recreate view if schema changed (see migration 008)

## Contact

For questions about database schema or migrations, contact the dev team or check the project docs.
