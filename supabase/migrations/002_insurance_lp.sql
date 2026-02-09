-- Insurance LP tables

create table if not exists insurance_lp_events (
  id            bigint generated always as identity primary key,
  slab          text not null,
  user_wallet   text not null,
  event_type    text not null check (event_type in ('deposit', 'withdraw')),
  collateral_amount bigint not null,
  lp_tokens     bigint not null,
  insurance_balance_before bigint not null,
  lp_supply_before bigint not null,
  tx_signature  text not null,
  created_at    timestamptz not null default now()
);

create index idx_insurance_lp_events_slab_created
  on insurance_lp_events (slab, created_at desc);

create table if not exists insurance_snapshots (
  id                bigint generated always as identity primary key,
  slab              text not null,
  insurance_balance bigint not null,
  lp_supply         bigint not null,
  redemption_rate_e6 bigint not null,
  snapshot_slot     bigint not null,
  created_at        timestamptz not null default now()
);

create index idx_insurance_snapshots_slab_created
  on insurance_snapshots (slab, created_at desc);

-- RLS: public read
alter table insurance_lp_events enable row level security;
alter table insurance_snapshots enable row level security;

create policy "Public read insurance_lp_events"
  on insurance_lp_events for select using (true);

create policy "Public read insurance_snapshots"
  on insurance_snapshots for select using (true);
