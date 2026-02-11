-- Bug Reports table for Percolator Launch
-- Run in Supabase SQL Editor

create table bug_reports (
  id uuid default gen_random_uuid() primary key,
  twitter_handle text not null,
  title text not null,
  description text not null,
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  page text,
  steps_to_reproduce text,
  expected_behavior text,
  actual_behavior text,
  wallet_address text,
  browser text,
  ip text,
  status text not null default 'open' check (status in ('open', 'investigating', 'fixed', 'wont_fix', 'duplicate')),
  admin_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Indexes
create index idx_bug_reports_status on bug_reports(status);
create index idx_bug_reports_severity on bug_reports(severity);
create index idx_bug_reports_created on bug_reports(created_at desc);
create index idx_bug_reports_handle on bug_reports(twitter_handle);

-- Auto-update updated_at
create trigger bug_reports_updated_at
  before update on bug_reports
  for each row execute function update_updated_at();

-- RLS
alter table bug_reports enable row level security;

-- Public can read bug reports (excluding ip and admin_notes)
create policy "Bug reports readable by all" on bug_reports
  for select using (true);

-- Service role can insert (API route uses service key)
create policy "Service can insert bug reports" on bug_reports
  for insert with check (true);

-- Service role can update (for admin status changes)
create policy "Service can update bug reports" on bug_reports
  for update using (true);
