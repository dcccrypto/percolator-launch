-- PERC allocation checker: private holder table + single-owner lookup + durable rate limit.
--
-- Target: the dedicated, private allocation-checker Postgres database (Neon project
-- `percolator-allocation-checker`), applied by its owner/import role. Plain Postgres; it
-- also runs on Supabase (anon/authenticated/service_role are revoked when present).
-- Setting the runtime role's password, importing the snapshot and adding the two
-- server-only env vars are operator steps outside git (see docs/ALLOCATION-VOTE.md).
--
-- Design
--   * Schema `perc_alloc` is NOT a PostgREST-exposed schema and grants nothing to
--     anon / authenticated / service_role, so the holder list is unreachable through
--     the Supabase REST/GraphQL APIs and the publishable key.
--   * The app connects as `perc_alloc_reader`, which can do exactly one thing:
--     EXECUTE perc_alloc.check_allocation(owner, client_key). It has no table
--     privileges at all, so it cannot list, dump or modify holders.
--   * check_allocation is SECURITY DEFINER, owned by the NOLOGIN role
--     `perc_alloc_definer`, which may only SELECT snapshot/holder and read/write the
--     rate-limit table. One owner per call, exact-match on the primary key.
--   * Rate limiting happens inside the same statement as the lookup, so it is atomic
--     and durable across serverless instances. Keys are 32-byte HMACs of the client
--     IP computed by the app; the database never sees a raw IP. Buckets are
--     sha256(scope || key). Limits are constants here, not caller-supplied.
--   * Balances are exact base units (numeric(20,0), u64 range). Allocations are
--     integer USD cents. Excluded owners carry their known reason codes.
--   * Snapshots are never deleted; a new import supersedes the active one inside one
--     transaction (versioned rows + a single active pointer), so a lookup sees either
--     the old snapshot or the new one, never a mix or a partial import.
--   * balance_basis is 'snapshot' for ordinary rows and 'exception' for an eligible
--     owner counted under an approved balance exception (provenance in snapshot).
--
-- Idempotent: safe to run more than once. Does not touch any existing table.

begin;

-- ─── Roles ───────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'perc_alloc_definer') then
    create role perc_alloc_definer nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'perc_alloc_reader') then
    -- NOLOGIN here on purpose. The operator enables login out of band with a
    -- generated password (never committed):
    --   alter role perc_alloc_reader login password '<generated>';
    create role perc_alloc_reader nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit;
  end if;
end
$$;

-- Needed so the migrating role may hand function ownership to the definer.
grant perc_alloc_definer to current_user;

alter role perc_alloc_reader set statement_timeout = '3s';
alter role perc_alloc_reader set idle_in_transaction_session_timeout = '10s';
alter role perc_alloc_reader connection limit 30;

-- ─── Schema ──────────────────────────────────────────────────────────────────
create schema if not exists perc_alloc;
revoke all on schema perc_alloc from public;
-- (Per-schema ALTER DEFAULT PRIVILEGES cannot remove the global PUBLIC EXECUTE
-- default on functions, so every function below is revoked from PUBLIC explicitly.)

create table if not exists perc_alloc.snapshot (
  id                     integer generated always as identity primary key,
  label                  text not null check (char_length(label) between 1 and 64),
  snapshot_date          date not null,
  snapshot_slot          bigint not null check (snapshot_slot > 0),
  token_decimals         smallint not null check (token_decimals between 0 and 18),
  allocation_status      text not null check (allocation_status = 'provisional'),
  full_raise_usd_cents   bigint not null check (full_raise_usd_cents > 0),
  floor_percent          numeric(5, 2) not null check (floor_percent > 0 and floor_percent <= 100),
  floor_usd_cents        bigint not null check (floor_usd_cents > 0),
  eligible_owners        integer not null check (eligible_owners > 0),
  excluded_owners        integer not null check (excluded_owners >= 0),
  eligible_raw_total     numeric(30, 0) not null check (eligible_raw_total > 0),
  eligible_csv_sha256    text not null check (eligible_csv_sha256 ~ '^[0-9a-f]{64}$'),
  all_holders_csv_sha256 text not null check (all_holders_csv_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256        text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  team_exclusion_basis   text not null check (char_length(team_exclusion_basis) between 1 and 500),
  team_exclusion_verified boolean not null,
  exception_owners       integer not null default 0 check (exception_owners >= 0),
  exception_basis        text check (exception_basis is null or char_length(exception_basis) between 1 and 4000),
  exception_files_sha256 text[] not null default '{}'
                         check (array_position(exception_files_sha256, null) is null),
  base_manifest_sha256   text check (base_manifest_sha256 is null or base_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  imported_at            timestamptz not null default now(),
  activated_at           timestamptz,
  superseded_at          timestamptz,
  is_active              boolean not null default false,
  check (floor_usd_cents * 100 = full_raise_usd_cents * floor_percent),
  check ((exception_owners = 0) = (exception_basis is null)),
  check (cardinality(exception_files_sha256) = exception_owners)
);
create unique index if not exists snapshot_one_active on perc_alloc.snapshot ((true)) where is_active;

create table if not exists perc_alloc.holder (
  snapshot_id          integer not null references perc_alloc.snapshot (id) on delete restrict,
  owner                text not null check (owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  eligible             boolean not null,
  balance_raw          numeric(20, 0) not null check (balance_raw > 0 and balance_raw <= 18446744073709551615),
  allocation_usd_cents bigint not null check (allocation_usd_cents >= 0),
  exclusion_reasons    text[] not null default '{}'
                       check (exclusion_reasons <@ array['off-curve', 'LP', 'burn']::text[]
                              and array_position(exclusion_reasons, null) is null
                              and cardinality(exclusion_reasons) <= 3),
  balance_basis        text not null default 'snapshot' check (balance_basis in ('snapshot', 'exception')),
  primary key (snapshot_id, owner),
  check (
    (eligible and cardinality(exclusion_reasons) = 0)
    or (not eligible and cardinality(exclusion_reasons) > 0 and allocation_usd_cents = 0)
  ),
  check (balance_basis = 'snapshot' or eligible)
);

create table if not exists perc_alloc.rate_limit (
  bucket       bytea primary key check (octet_length(bucket) = 32),
  window_start timestamptz not null,
  hits         integer not null check (hits >= 0),
  expires_at   timestamptz not null
);
create index if not exists rate_limit_expires_at on perc_alloc.rate_limit (expires_at);

revoke all on perc_alloc.snapshot, perc_alloc.holder, perc_alloc.rate_limit from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'perc_alloc_reader'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema perc_alloc from %I', r);
      execute format('revoke all on all tables in schema perc_alloc from %I', r);
      execute format('revoke all on all sequences in schema perc_alloc from %I', r);
      execute format('revoke all on all functions in schema perc_alloc from %I', r);
    end if;
  end loop;
end
$$;

grant usage on schema perc_alloc to perc_alloc_definer, perc_alloc_reader;
grant select on perc_alloc.snapshot, perc_alloc.holder to perc_alloc_definer;
grant select, insert, update, delete on perc_alloc.rate_limit to perc_alloc_definer;

-- ALTER ... OWNER TO requires the new owner to hold CREATE on the schema; it is
-- granted only for the ownership transfers below and revoked again before commit.
grant create on schema perc_alloc to perc_alloc_definer;

-- ─── Fixed-window counter: returns 0 when allowed, else seconds until reset ──
create or replace function perc_alloc._hit(p_bucket bytea, p_window_secs integer, p_max integer, p_now timestamptz)
returns integer
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_hits integer;
  v_exp  timestamptz;
begin
  insert into perc_alloc.rate_limit as r (bucket, window_start, hits, expires_at)
  values (p_bucket, p_now, 1, p_now + make_interval(secs => p_window_secs))
  on conflict (bucket) do update
    set window_start = case when r.expires_at <= p_now then p_now else r.window_start end,
        hits         = case when r.expires_at <= p_now then 1 else least(r.hits, 2147483646) + 1 end,
        expires_at   = case when r.expires_at <= p_now then p_now + make_interval(secs => p_window_secs) else r.expires_at end
  returning hits, expires_at into v_hits, v_exp;
  if v_hits > p_max then
    return greatest(1, ceil(extract(epoch from (v_exp - p_now)))::integer);
  end if;
  return 0;
end
$$;
alter function perc_alloc._hit(bytea, integer, integer, timestamptz) owner to perc_alloc_definer;
revoke all on function perc_alloc._hit(bytea, integer, integer, timestamptz) from public;

-- ─── The only runtime entry point ────────────────────────────────────────────
-- outcome: invalid | rate_limited | unavailable | not_found | eligible | excluded
-- Figures are returned ONLY for eligible/excluded; not_found never gets a zero.
drop function if exists perc_alloc.check_allocation(text, bytea);
create function perc_alloc.check_allocation(p_owner text, p_client_key bytea)
returns table (
  outcome              text,
  retry_after_seconds  integer,
  eligible             boolean,
  balance_raw          text,
  token_decimals       smallint,
  allocation_usd_cents bigint,
  exclusion_reasons    text[],
  snapshot_label       text,
  allocation_status    text,
  balance_basis        text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- Limits (constants; a caller cannot raise them)
  c_client_min_max  constant integer := 10;   -- per client key per 60 s
  c_client_hour_max constant integer := 60;   -- per client key per 3600 s
  c_global_min_max  constant integer := 600;  -- all clients together per 60 s
  v_now   timestamptz := now();
  v_retry integer;
  v_snap  perc_alloc.snapshot%rowtype;
  v_h     perc_alloc.holder%rowtype;
begin
  if p_owner is null or p_client_key is null or octet_length(p_client_key) <> 32
     or char_length(p_owner) not between 32 and 44
     or p_owner !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    return query select 'invalid'::text, 0, null::boolean, null::text, null::smallint, null::bigint, null::text[], null::text, null::text, null::text;
    return;
  end if;

  -- Opportunistic expiry of old buckets (bounded work per call).
  delete from perc_alloc.rate_limit
   where ctid = any (array(select rl.ctid from perc_alloc.rate_limit rl
                            where rl.expires_at < v_now - interval '1 minute'
                            limit 50 for update skip locked));

  v_retry := perc_alloc._hit(sha256('perc_alloc:client:60:'::bytea || p_client_key), 60, c_client_min_max, v_now);
  v_retry := greatest(v_retry, perc_alloc._hit(sha256('perc_alloc:client:3600:'::bytea || p_client_key), 3600, c_client_hour_max, v_now));
  if v_retry = 0 then
    v_retry := perc_alloc._hit(sha256('perc_alloc:global:60'::bytea), 60, c_global_min_max, v_now);
  end if;
  if v_retry > 0 then
    return query select 'rate_limited'::text, v_retry, null::boolean, null::text, null::smallint, null::bigint, null::text[], null::text, null::text, null::text;
    return;
  end if;

  select * into v_snap from perc_alloc.snapshot s where s.is_active;
  if not found then
    return query select 'unavailable'::text, 0, null::boolean, null::text, null::smallint, null::bigint, null::text[], null::text, null::text, null::text;
    return;
  end if;

  select * into v_h from perc_alloc.holder h where h.snapshot_id = v_snap.id and h.owner = p_owner;
  if not found then
    return query select 'not_found'::text, 0, null::boolean, null::text, null::smallint, null::bigint, null::text[], v_snap.label, v_snap.allocation_status, null::text;
    return;
  end if;

  return query select
    case when v_h.eligible then 'eligible' else 'excluded' end,
    0,
    v_h.eligible,
    v_h.balance_raw::text,
    v_snap.token_decimals,
    case when v_h.eligible then v_h.allocation_usd_cents else null end,
    v_h.exclusion_reasons,
    v_snap.label,
    v_snap.allocation_status,
    v_h.balance_basis;
end
$$;
alter function perc_alloc.check_allocation(text, bytea) owner to perc_alloc_definer;
revoke all on function perc_alloc.check_allocation(text, bytea) from public;
grant execute on function perc_alloc.check_allocation(text, bytea) to perc_alloc_reader;
revoke create on schema perc_alloc from perc_alloc_definer;

-- Repeat the role revokes now that the functions exist: on Supabase, default
-- privileges can grant EXECUTE on newly created functions to anon /
-- authenticated / service_role, after the first revoke pass above.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema perc_alloc from %I', r);
      execute format('revoke all on all tables in schema perc_alloc from %I', r);
      execute format('revoke all on all sequences in schema perc_alloc from %I', r);
      execute format('revoke all on all functions in schema perc_alloc from %I', r);
    end if;
  end loop;
end
$$;
revoke all on function perc_alloc._hit(bytea, integer, integer, timestamptz) from perc_alloc_reader;

commit;

-- ─── Verification (run after applying; expected results in comments) ─────────
-- select has_schema_privilege('anon', 'perc_alloc', 'USAGE');                        -- false
-- select has_table_privilege('perc_alloc_reader', 'perc_alloc.holder', 'SELECT');    -- false
-- select has_function_privilege('perc_alloc_reader', 'perc_alloc.check_allocation(text, bytea)', 'EXECUTE');  -- true
-- select has_function_privilege('perc_alloc_reader', 'perc_alloc._hit(bytea, integer, integer, timestamptz)', 'EXECUTE'); -- false
-- Supabase dashboard: API settings -> Exposed schemas must NOT include perc_alloc.
--
-- ─── Rollback (removes the feature's database objects; holder data is lost) ──
-- begin;
-- drop schema perc_alloc cascade;
-- drop role if exists perc_alloc_reader;
-- revoke perc_alloc_definer from current_user;
-- drop role if exists perc_alloc_definer;
-- commit;
