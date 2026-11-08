-- PERC holder vote: weekly fee claims vs buy-and-burn, balance weighted.
--
-- !! APPLY AFTER 20261108000000_perc_alloc_private_lookup.sql, TO THE SAME DATABASE.
-- !! NOT APPLIED BY THIS CHANGE. Applying it and setting VOTE_ADMIN_SECRET are
-- !! external changes that need explicit owner approval (see docs/ALLOCATION-VOTE.md).
-- !! Applying it does NOT start the vote: with no poll row the vote is NOT STARTED.
--
-- Design
--   * Voter list = eligible rows of perc_alloc.holder for the snapshot that was
--     active when the poll was started (the poll pins snapshot_id; a later
--     snapshot activation never changes who may vote or their weight).
--   * Schema `perc_vote` is private (no grants to anon / authenticated /
--     service_role). The runtime role perc_alloc_reader can only EXECUTE the
--     SECURITY DEFINER functions below; it has no table privileges.
--   * All times come from the database clock (clock_timestamp()), never the app.
--   * A vote needs a server-issued single-use nonce bound to (poll, wallet,
--     choice, issued_at, expires_at). The app verifies the Ed25519 signature
--     over the canonical message; cast_vote rebuilds that message itself and
--     refuses any mismatch, then consumes the nonce with a conditional UPDATE
--     (row-locked, so concurrent replays consume it at most once) and upserts
--     the wallet's single ballot row in the same transaction.
--   * Last valid vote wins: a ballot is only replaced by a vote cast later
--     (by database time); every replacement bumps `revision`.
--   * Tally: exact numeric sums of snapshot balance_raw per choice, published
--     only once the 24h window has closed, aggregates only. Ties and zero
--     votes resolve to buy-and-burn. No quorum.
--   * start_poll is one-shot (a poll key can never be restarted or extended);
--     the app only calls it behind the server-only VOTE_ADMIN_SECRET. NOTE: the
--     runtime role can EXECUTE start_poll, so the runtime database credential
--     must be treated as able to start the poll (it lives only in server env).
--   * Pinning relies on holder rows of a snapshot never being edited after
--     import (the definer has SELECT only; only the import/owner role can write).
--
-- Idempotent: safe to run more than once. Changes no perc_alloc object.

begin;

create schema if not exists perc_vote;
revoke all on schema perc_vote from public;

create table if not exists perc_vote.poll (
  id                  integer generated always as identity primary key,
  poll_key            text not null unique check (poll_key ~ '^[a-z0-9-]{1,48}$'),
  snapshot_id         integer not null references perc_alloc.snapshot (id) on delete restrict,
  snapshot_csv_sha256 text not null check (snapshot_csv_sha256 ~ '^[0-9a-f]{64}$'),
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  created_at          timestamptz not null default clock_timestamp(),
  check (ends_at = starts_at + interval '24 hours')
);

create table if not exists perc_vote.nonce (
  nonce       text primary key check (nonce ~ '^[0-9a-f]{64}$'),
  poll_id     integer not null references perc_vote.poll (id) on delete restrict,
  owner       text not null check (owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  choice      text not null check (choice in ('weekly-fee-claims', 'buy-and-burn')),
  issued_at   timestamptz not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > issued_at and expires_at <= issued_at + interval '10 minutes')
);
create index if not exists nonce_expires_at on perc_vote.nonce (expires_at);

create table if not exists perc_vote.ballot (
  poll_id   integer not null references perc_vote.poll (id) on delete restrict,
  owner     text not null check (owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  choice    text not null check (choice in ('weekly-fee-claims', 'buy-and-burn')),
  nonce     text not null unique references perc_vote.nonce (nonce),
  message   text not null check (char_length(message) between 1 and 1024),
  signature bytea not null check (octet_length(signature) = 64),
  cast_at   timestamptz not null,
  revision  integer not null default 1 check (revision >= 1),
  primary key (poll_id, owner)
);

revoke all on perc_vote.poll, perc_vote.nonce, perc_vote.ballot from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'perc_alloc_reader'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema perc_vote from %I', r);
      execute format('revoke all on all tables in schema perc_vote from %I', r);
      execute format('revoke all on all sequences in schema perc_vote from %I', r);
      execute format('revoke all on all functions in schema perc_vote from %I', r);
    end if;
  end loop;
end
$$;

grant usage on schema perc_vote to perc_alloc_definer, perc_alloc_reader;
-- The definer may create polls but never edit or delete them; nonces are only
-- consumed or expired-and-unconsumed purged; ballots are upserted, never deleted.
grant select, insert on perc_vote.poll to perc_alloc_definer;
grant select, insert, update (consumed_at), delete on perc_vote.nonce to perc_alloc_definer;
grant select, insert, update (choice, nonce, message, signature, cast_at, revision) on perc_vote.ballot to perc_alloc_definer;
grant usage on all sequences in schema perc_vote to perc_alloc_definer;
grant create on schema perc_vote to perc_alloc_definer;

-- ─── Constants ───────────────────────────────────────────────────────────────
create or replace function perc_vote._poll_key() returns text
language sql immutable set search_path = pg_catalog, pg_temp
as $$ select 'perc-fee-policy-2026-11'::text $$;

create or replace function perc_vote._ts(p timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp
as $$ select to_char(p at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- The exact text the wallet signs. MUST stay byte-identical to
-- app/lib/allocation-vote/vote-message.ts (a test compares the two).
create or replace function perc_vote._message(p_poll_key text, p_choice text, p_owner text, p_nonce text,
                                              p_issued_at text, p_expires_at text) returns text
language sql immutable set search_path = pg_catalog, pg_temp
as $$
  select 'percolator.trade PERC holder vote' || E'\n'
      || 'Action: cast-vote' || E'\n'
      || 'Domain: percolator.trade' || E'\n'
      || 'Poll: ' || p_poll_key || E'\n'
      || 'Choice: ' || p_choice || E'\n'
      || 'Wallet: ' || p_owner || E'\n'
      || 'Nonce: ' || p_nonce || E'\n'
      || 'Issued At: ' || p_issued_at || E'\n'
      || 'Expires At: ' || p_expires_at || E'\n'
      || 'Signing records a vote only. It is not a transaction and moves no funds.'
$$;

create or replace function perc_vote._state(p_poll perc_vote.poll, p_now timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp
as $$
  select case when p_poll.id is null then 'not_started'
              when p_now < p_poll.starts_at then 'not_started'
              when p_now < p_poll.ends_at then 'open'
              else 'closed' end
$$;

create or replace function perc_vote._valid_owner(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp
as $$ select p is not null and char_length(p) between 32 and 44 and p ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' $$;

-- Opportunistic, bounded expiry of old rate-limit buckets (same as the checker's).
create or replace function perc_vote._purge_limits(p_now timestamptz) returns void
language sql volatile set search_path = pg_catalog, pg_temp
as $$
  delete from perc_alloc.rate_limit
   where ctid = any (array(select rl.ctid from perc_alloc.rate_limit rl
                            where rl.expires_at < p_now - interval '1 minute'
                            limit 50 for update skip locked))
$$;

-- ─── status: public poll state (no per-wallet data) ─────────────────────────
create or replace function perc_vote.status(p_client_key bytea)
returns table (outcome text, retry_after_seconds integer, state text, poll_key text,
               starts_at text, ends_at text, server_now text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_poll perc_vote.poll;
  v_retry integer;
begin
  if p_client_key is null or octet_length(p_client_key) <> 32 then
    return query select 'invalid'::text, 0, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  v_retry := perc_alloc._hit(sha256('perc_vote:status:60:'::bytea || p_client_key), 60, 60, v_now);
  if v_retry > 0 then
    return query select 'rate_limited'::text, v_retry, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;
  select * into v_poll from perc_vote.poll p where p.poll_key = perc_vote._poll_key();
  return query select 'ok'::text, 0, perc_vote._state(v_poll, v_now), perc_vote._poll_key(),
    case when v_poll.id is null then null else perc_vote._ts(v_poll.starts_at) end,
    case when v_poll.id is null then null else perc_vote._ts(v_poll.ends_at) end,
    perc_vote._ts(v_now);
end
$$;

-- ─── issue_nonce: single-use challenge for one wallet + one choice ──────────
-- outcome: invalid | rate_limited | not_started | closed | not_eligible | ok
create or replace function perc_vote.issue_nonce(p_owner text, p_choice text, p_client_key bytea)
returns table (outcome text, retry_after_seconds integer, poll_key text, nonce text,
               issued_at text, expires_at text, message text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now   timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_poll  perc_vote.poll;
  v_retry integer;
  v_nonce text;
  v_exp   timestamptz;
begin
  if not perc_vote._valid_owner(p_owner) or p_choice is null
     or p_choice not in ('weekly-fee-claims', 'buy-and-burn')
     or p_client_key is null or octet_length(p_client_key) <> 32 then
    return query select 'invalid'::text, 0, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  delete from perc_vote.nonce
   where ctid = any (array(select n.ctid from perc_vote.nonce n
                            where n.consumed_at is null and n.expires_at < v_now - interval '1 hour'
                            limit 50 for update skip locked));

  perform perc_vote._purge_limits(v_now);
  v_retry := perc_alloc._hit(sha256('perc_vote:nonce:client:60:'::bytea || p_client_key), 60, 20, v_now);
  -- No per-wallet limit here on purpose: anyone may request a challenge for any
  -- wallet, so a per-wallet bucket would let a stranger lock a holder out.
  if v_retry = 0 then
    v_retry := perc_alloc._hit(sha256('perc_vote:nonce:global:60'::bytea), 60, 3000, v_now);
  end if;
  if v_retry > 0 then
    return query select 'rate_limited'::text, v_retry, null::text, null::text, null::text, null::text, null::text;
    return;
  end if;

  select * into v_poll from perc_vote.poll p where p.poll_key = perc_vote._poll_key();
  if perc_vote._state(v_poll, v_now) <> 'open' then
    return query select perc_vote._state(v_poll, v_now), 0, perc_vote._poll_key(), null::text, null::text, null::text, null::text;
    return;
  end if;
  if not exists (select 1 from perc_alloc.holder h
                  where h.snapshot_id = v_poll.snapshot_id and h.owner = p_owner and h.eligible) then
    return query select 'not_eligible'::text, 0, v_poll.poll_key, null::text, null::text, null::text, null::text;
    return;
  end if;

  v_nonce := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := least(v_now + interval '5 minutes', v_poll.ends_at);
  insert into perc_vote.nonce (nonce, poll_id, owner, choice, issued_at, expires_at)
  values (v_nonce, v_poll.id, p_owner, p_choice, v_now, v_exp);
  return query select 'ok'::text, 0, v_poll.poll_key, v_nonce, perc_vote._ts(v_now), perc_vote._ts(v_exp),
    perc_vote._message(v_poll.poll_key, p_choice, p_owner, v_nonce, perc_vote._ts(v_now), perc_vote._ts(v_exp));
end
$$;

-- ─── cast_vote: called ONLY after the app verified the Ed25519 signature ────
-- outcome: invalid | rate_limited | not_started | closed | not_eligible |
--          bad_nonce | expired | message_mismatch | superseded | recorded
create or replace function perc_vote.cast_vote(p_owner text, p_choice text, p_nonce text, p_issued_at text, p_expires_at text,
                                    p_message text, p_signature bytea, p_client_key bytea)
returns table (outcome text, retry_after_seconds integer, choice text, revision integer, cast_at text, ends_at text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now   timestamptz;
  v_poll  perc_vote.poll;
  v_retry integer;
  v_n     perc_vote.nonce;
  v_found boolean;
  v_rev   integer;
begin
  if not perc_vote._valid_owner(p_owner) or p_choice is null
     or p_choice not in ('weekly-fee-claims', 'buy-and-burn')
     or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
     or p_issued_at is null or p_expires_at is null or p_message is null or char_length(p_message) > 1024
     or p_signature is null or octet_length(p_signature) <> 64
     or p_client_key is null or octet_length(p_client_key) <> 32 then
    return query select 'invalid'::text, 0, null::text, null::integer, null::text, null::text;
    return;
  end if;

  v_now := clock_timestamp();
  -- Per-client and global limits were applied by submit_gate before the app
  -- verified the signature; only the wallet's own signature reaches here, so
  -- a per-wallet limit cannot be used by strangers to lock a holder out.
  v_retry := perc_alloc._hit(sha256(convert_to('perc_vote:cast:owner:600:' || p_owner, 'UTF8')), 600, 20, v_now);
  if v_retry > 0 then
    return query select 'rate_limited'::text, v_retry, null::text, null::integer, null::text, null::text;
    return;
  end if;

  select * into v_poll from perc_vote.poll p where p.poll_key = perc_vote._poll_key();
  if p_message is distinct from perc_vote._message(perc_vote._poll_key(), p_choice, p_owner, p_nonce, p_issued_at, p_expires_at) then
    return query select 'message_mismatch'::text, 0, null::text, null::integer, null::text, null::text;
    return;
  end if;

  -- Lock the nonce row first: concurrent submissions of the same nonce queue
  -- here, and only the first sees consumed_at is null.
  select * into v_n from perc_vote.nonce n where n.nonce = p_nonce for update;
  v_found := found;
  -- Time is read AFTER the lock so a queued replay cannot use a stale clock.
  v_now := clock_timestamp();
  if perc_vote._state(v_poll, v_now) <> 'open' then
    return query select perc_vote._state(v_poll, v_now), 0, null::text, null::integer, null::text,
      case when v_poll.id is null then null else perc_vote._ts(v_poll.ends_at) end;
    return;
  end if;
  if not v_found or v_n.poll_id <> v_poll.id or v_n.owner <> p_owner or v_n.choice <> p_choice
     or perc_vote._ts(v_n.issued_at) <> p_issued_at or perc_vote._ts(v_n.expires_at) <> p_expires_at
     or v_n.consumed_at is not null then
    return query select 'bad_nonce'::text, 0, null::text, null::integer, null::text, null::text;
    return;
  end if;
  if v_n.expires_at <= v_now then
    return query select 'expired'::text, 0, null::text, null::integer, null::text, null::text;
    return;
  end if;
  if not exists (select 1 from perc_alloc.holder h
                  where h.snapshot_id = v_poll.snapshot_id and h.owner = p_owner and h.eligible) then
    return query select 'not_eligible'::text, 0, null::text, null::integer, null::text, null::text;
    return;
  end if;

  update perc_vote.nonce n set consumed_at = v_now where n.nonce = p_nonce and n.consumed_at is null;

  insert into perc_vote.ballot as b (poll_id, owner, choice, nonce, message, signature, cast_at)
  values (v_poll.id, p_owner, p_choice, p_nonce, p_message, p_signature, v_now)
  on conflict (poll_id, owner) do update
    set choice = excluded.choice, nonce = excluded.nonce, message = excluded.message,
        signature = excluded.signature, cast_at = excluded.cast_at, revision = b.revision + 1
    where b.cast_at < excluded.cast_at
  returning b.revision into v_rev;
  if v_rev is null then
    -- A vote for this wallet with a later database time is already recorded.
    return query select 'superseded'::text, 0, null::text, null::integer, null::text, perc_vote._ts(v_poll.ends_at);
    return;
  end if;
  return query select 'recorded'::text, 0, p_choice, v_rev, perc_vote._ts(v_now), perc_vote._ts(v_poll.ends_at);
end
$$;

-- ─── tally: aggregate result, only after the window closed ──────────────────
-- winner is weekly-fee-claims only on a strict balance majority; ties and zero
-- votes resolve to buy-and-burn.
create or replace function perc_vote.tally(p_client_key bytea)
returns table (outcome text, retry_after_seconds integer, state text, poll_key text, ends_at text,
               weekly_fee_claims_raw text, buy_and_burn_raw text, weekly_fee_claims_wallets integer,
               buy_and_burn_wallets integer, eligible_raw_total text, eligible_wallets integer,
               token_decimals smallint, winner text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_poll perc_vote.poll;
  v_retry integer;
  v_fee numeric; v_burn numeric; v_fee_n integer; v_burn_n integer;
  v_snap perc_alloc.snapshot;
begin
  if p_client_key is null or octet_length(p_client_key) <> 32 then
    return query select 'invalid'::text, 0, null::text, null::text, null::text, null::text, null::text,
      null::integer, null::integer, null::text, null::integer, null::smallint, null::text;
    return;
  end if;
  v_retry := perc_alloc._hit(sha256('perc_vote:tally:60:'::bytea || p_client_key), 60, 60, v_now);
  if v_retry > 0 then
    return query select 'rate_limited'::text, v_retry, null::text, null::text, null::text, null::text, null::text,
      null::integer, null::integer, null::text, null::integer, null::smallint, null::text;
    return;
  end if;
  select * into v_poll from perc_vote.poll p where p.poll_key = perc_vote._poll_key();
  -- 'tallying' for 60 s after ends_at: a cast that passed its window check just
  -- before ends_at may still be committing (the runtime role's statement_timeout
  -- is 3 s), so no figures are published until every such cast has finished.
  -- The result is then final and cannot change between calls.
  if perc_vote._state(v_poll, v_now) = 'closed' and v_now < v_poll.ends_at + interval '60 seconds' then
    return query select 'ok'::text, 0, 'tallying'::text, perc_vote._poll_key(), perc_vote._ts(v_poll.ends_at),
      null::text, null::text, null::integer, null::integer, null::text, null::integer, null::smallint, null::text;
    return;
  end if;
  if perc_vote._state(v_poll, v_now) <> 'closed' then
    return query select 'ok'::text, 0, perc_vote._state(v_poll, v_now), perc_vote._poll_key(),
      case when v_poll.id is null then null else perc_vote._ts(v_poll.ends_at) end,
      null::text, null::text, null::integer, null::integer, null::text, null::integer, null::smallint, null::text;
    return;
  end if;
  select * into v_snap from perc_alloc.snapshot s where s.id = v_poll.snapshot_id;
  select coalesce(sum(h.balance_raw) filter (where b.choice = 'weekly-fee-claims'), 0),
         coalesce(sum(h.balance_raw) filter (where b.choice = 'buy-and-burn'), 0),
         count(*) filter (where b.choice = 'weekly-fee-claims')::integer,
         count(*) filter (where b.choice = 'buy-and-burn')::integer
    into v_fee, v_burn, v_fee_n, v_burn_n
    from perc_vote.ballot b
    join perc_alloc.holder h on h.snapshot_id = v_poll.snapshot_id and h.owner = b.owner and h.eligible
   where b.poll_id = v_poll.id and b.cast_at >= v_poll.starts_at and b.cast_at < v_poll.ends_at;
  return query select 'ok'::text, 0, 'closed'::text, v_poll.poll_key, perc_vote._ts(v_poll.ends_at),
    v_fee::text, v_burn::text, v_fee_n, v_burn_n,
    (select coalesce(sum(h.balance_raw), 0)::text from perc_alloc.holder h where h.snapshot_id = v_poll.snapshot_id and h.eligible),
    (select count(*)::integer from perc_alloc.holder h where h.snapshot_id = v_poll.snapshot_id and h.eligible),
    v_snap.token_decimals,
    case when v_fee > v_burn then 'weekly-fee-claims' else 'buy-and-burn' end;
end
$$;

-- ─── submit_gate: per-client/global limiter run BEFORE signature checks ─────
create or replace function perc_vote.submit_gate(p_client_key bytea)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_retry integer;
begin
  if p_client_key is null or octet_length(p_client_key) <> 32 then
    return 3600;
  end if;
  perform perc_vote._purge_limits(v_now);
  v_retry := perc_alloc._hit(sha256('perc_vote:submit:client:60:'::bytea || p_client_key), 60, 20, v_now);
  if v_retry = 0 then
    v_retry := perc_alloc._hit(sha256('perc_vote:submit:global:60'::bytea), 60, 3000, v_now);
  end if;
  return v_retry;
end
$$;

-- ─── admin: attempt limiter (called before the secret is compared) ──────────
create or replace function perc_vote.admin_gate(p_client_key bytea)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_client_key is null or octet_length(p_client_key) <> 32 then
    return 3600;
  end if;
  -- Per client only, on purpose: a global bucket would let one stranger lock the
  -- admin out of starting the vote. The secret (>= 32 chars) is not guessable
  -- at 5 attempts per client per 15 minutes.
  return perc_alloc._hit(sha256('perc_vote:admin:client:900:'::bytea || p_client_key), 900, 5, v_now);
end
$$;

-- ─── start_poll: one-shot, 24h from now, pinned to the active snapshot ──────
-- outcome: started | already_started | no_snapshot | invalid
create or replace function perc_vote.start_poll(p_poll_key text)
returns table (outcome text, starts_at text, ends_at text, snapshot_label text)
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now  timestamptz := date_trunc('seconds', clock_timestamp());
  v_snap perc_alloc.snapshot;
  v_poll perc_vote.poll;
begin
  if p_poll_key is distinct from perc_vote._poll_key() then
    return query select 'invalid'::text, null::text, null::text, null::text;
    return;
  end if;
  select * into v_snap from perc_alloc.snapshot s where s.is_active;
  if not found then
    return query select 'no_snapshot'::text, null::text, null::text, null::text;
    return;
  end if;
  insert into perc_vote.poll (poll_key, snapshot_id, snapshot_csv_sha256, starts_at, ends_at)
  values (p_poll_key, v_snap.id, v_snap.eligible_csv_sha256, v_now, v_now + interval '24 hours')
  on conflict (poll_key) do nothing
  returning * into v_poll;
  if v_poll.id is null then
    select * into v_poll from perc_vote.poll p where p.poll_key = p_poll_key;
    return query select 'already_started'::text, perc_vote._ts(v_poll.starts_at), perc_vote._ts(v_poll.ends_at), null::text;
    return;
  end if;
  return query select 'started'::text, perc_vote._ts(v_poll.starts_at), perc_vote._ts(v_poll.ends_at), v_snap.label;
end
$$;

-- ─── Ownership + EXECUTE grants ──────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'perc_vote._poll_key()', 'perc_vote._ts(timestamptz)',
    'perc_vote._message(text, text, text, text, text, text)', 'perc_vote._state(perc_vote.poll, timestamptz)',
    'perc_vote._valid_owner(text)', 'perc_vote._purge_limits(timestamptz)', 'perc_vote.status(bytea)', 'perc_vote.issue_nonce(text, text, bytea)',
    'perc_vote.cast_vote(text, text, text, text, text, text, bytea, bytea)', 'perc_vote.tally(bytea)',
    'perc_vote.submit_gate(bytea)', 'perc_vote.admin_gate(bytea)', 'perc_vote.start_poll(text)'] loop
    execute format('alter function %s owner to perc_alloc_definer', f);
    execute format('revoke all on function %s from public', f);
  end loop;
  foreach f in array array[
    'perc_vote.status(bytea)', 'perc_vote.issue_nonce(text, text, bytea)',
    'perc_vote.cast_vote(text, text, text, text, text, text, bytea, bytea)', 'perc_vote.tally(bytea)',
    'perc_vote.submit_gate(bytea)', 'perc_vote.admin_gate(bytea)', 'perc_vote.start_poll(text)'] loop
    execute format('grant execute on function %s to perc_alloc_reader', f);
  end loop;
end
$$;
-- (perc_alloc_definer already owns perc_alloc._hit, so the vote functions may call it.)
revoke create on schema perc_vote from perc_alloc_definer;

-- Second revoke pass for Supabase-style default privileges on new functions.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema perc_vote from %I', r);
      execute format('revoke all on all tables in schema perc_vote from %I', r);
      execute format('revoke all on all sequences in schema perc_vote from %I', r);
      execute format('revoke all on all functions in schema perc_vote from %I', r);
    end if;
  end loop;
end
$$;

commit;

-- ─── Verification (expected results in comments) ─────────────────────────────
-- select has_schema_privilege('anon', 'perc_vote', 'USAGE');                       -- false
-- select has_table_privilege('perc_alloc_reader', 'perc_vote.ballot', 'SELECT');   -- false
-- select count(*) from perc_vote.poll;                                             -- 0  (NOT STARTED)
--
-- ─── Rollback (removes vote objects; ballots are lost) ───────────────────────
-- begin; drop schema perc_vote cascade; commit;
