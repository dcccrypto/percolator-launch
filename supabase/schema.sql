-- ⚠️ NOTE: This file is for reference only.
-- The source of truth is the migrations in supabase/migrations/.
-- Regenerate this file with: supabase db dump --schema public > supabase/schema.sql

-- Percolator Launch — Market Registry Schema
-- Run in Supabase SQL Editor

-- Markets table — core registry
create table markets (
  id uuid default gen_random_uuid() primary key,
  slab_address text unique not null,
  mint_address text not null,
  symbol text not null,
  name text not null,
  decimals int not null default 6,
  deployer text not null,
  oracle_authority text,
  initial_price_e6 bigint,
  max_leverage int not null default 10,
  trading_fee_bps int not null default 10,
  lp_collateral numeric,
  matcher_context text,
  status text not null default 'active' check (status in ('active', 'paused', 'resolved')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Market stats — updated by indexer/crank
create table market_stats (
  slab_address text primary key references markets(slab_address) on delete cascade,
  last_price numeric,
  mark_price numeric,
  index_price numeric,
  volume_24h numeric default 0,
  open_interest numeric default 0,
  num_traders integer default 0,
  vault_balance numeric default 0,
  insurance_balance numeric default 0,
  last_crank_slot bigint,
  total_accounts int default 0,
  funding_rate numeric default 0,
  updated_at timestamptz default now()
);

-- Trade history — populated by indexer
create table trades (
  id uuid default gen_random_uuid() primary key,
  slab_address text not null references markets(slab_address) on delete cascade,
  trader text not null,
  side text not null check (side in ('long', 'short')),
  size numeric not null,
  price numeric not null,
  fee numeric not null default 0,
  tx_signature text unique,
  slot bigint,
  created_at timestamptz default now()
);

-- Oracle price history — for charts
create table oracle_prices (
  id bigserial primary key,
  slab_address text not null references markets(slab_address) on delete cascade,
  price_e6 bigint not null,
  timestamp bigint not null,
  tx_signature text,
  created_at timestamptz default now()
);

-- Indexes
create index idx_markets_status on markets(status);
create index idx_markets_mint on markets(mint_address);
create index idx_markets_deployer on markets(deployer);
create index idx_trades_slab on trades(slab_address, created_at desc);
create index idx_trades_trader on trades(trader, created_at desc);
create index idx_oracle_prices_slab on oracle_prices(slab_address, created_at desc);
create index idx_oracle_prices_slab_time on oracle_prices(slab_address, timestamp desc);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger markets_updated_at
  before update on markets
  for each row execute function update_updated_at();

create trigger market_stats_updated_at
  before update on market_stats
  for each row execute function update_updated_at();

-- RLS policies
alter table markets enable row level security;
alter table market_stats enable row level security;
alter table trades enable row level security;
alter table oracle_prices enable row level security;

-- Public read access
create policy "Markets readable by all" on markets for select using (true);
create policy "Stats readable by all" on market_stats for select using (true);
create policy "Trades readable by all" on trades for select using (true);
create policy "Prices readable by all" on oracle_prices for select using (true);

-- Service role writes (API routes use service key)
--
-- GH#2499: every one of these MUST carry `to service_role`. A policy with no `TO`
-- clause applies to the PUBLIC pseudo-role, which includes `anon` — the role behind
-- NEXT_PUBLIC_SUPABASE_ANON_KEY — so an omission here lets anyone holding the public
-- key INSERT fake markets/trades or UPDATE stats/prices straight through PostgREST,
-- bypassing every check in the API routes.
--
-- This file previously omitted them. Migration 021 added service_role-only policies
-- alongside, and 20260402180100 dropped these permissive ones by name, so a database
-- built from `supabase/migrations/` is not affected. But this file is the reference
-- schema that still gets run by hand in the Supabase SQL Editor to bootstrap an
-- environment, and PostgreSQL OR's permissive policies — re-running the old version
-- would silently re-open write access alongside the correct policies, exactly what
-- 20260402180100 exists to undo. Fixed at the source so a fresh bootstrap is safe.
create policy "Service can insert markets" on markets for insert to service_role with check (true);
create policy "Service can update markets" on markets for update to service_role using (true) with check (true);
create policy "Service can insert stats" on market_stats for insert to service_role with check (true);
create policy "Service can update stats" on market_stats for update to service_role using (true) with check (true);
create policy "Service can insert trades" on trades for insert to service_role with check (true);
create policy "Service can insert prices" on oracle_prices for insert to service_role with check (true);

-- Realtime subscriptions
alter publication supabase_realtime add table markets;
alter publication supabase_realtime add table market_stats;

-- View: markets with stats joined (for frontend)
create or replace view markets_with_stats as
select
  m.*,
  s.last_price,
  s.mark_price,
  s.index_price,
  s.volume_24h,
  s.open_interest,
  s.num_traders,
  s.vault_balance,
  s.insurance_balance,
  s.last_crank_slot,
  s.total_accounts,
  s.funding_rate,
  s.updated_at as stats_updated_at
from markets m
left join market_stats s on m.slab_address = s.slab_address
where m.status = 'active'
order by s.volume_24h desc nulls last;
