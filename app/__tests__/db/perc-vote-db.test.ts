/**
 * PERC holder vote private schema, against a throwaway local Postgres
 * (the checker migration + the vote migration, applied as a non-superuser).
 *
 *  - NOT STARTED by default; start is one-shot, exactly 24h, pinned snapshot
 *  - nonce: single use (incl. concurrent replay), expiry, wallet/choice binding
 *  - message binding: the DB rebuilds the signed text and refuses mismatches
 *  - eligibility: only eligible rows of the pinned snapshot
 *  - one ballot row per wallet; later vote replaces earlier; races
 *  - tally: exact numeric sums, hidden until closed, ties/zero -> buy-and-burn
 *  - runtime role has no table access
 *
 * All wallets are freshly generated SYNTHETIC keypairs, and every vote carries a
 * genuine Ed25519 signature. Skipped when no local Postgres binaries are found.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { findPgBin, migrate, startCluster, withClient, type Cluster } from "./pg-harness";
import { syntheticKey, syntheticOwner } from "./synthetic";
import { applySnapshot, type ValidatedSnapshot, type HolderRow } from "@/scripts/allocation/import-lib";
import { buildVoteMessage, type VoteChoice } from "@/lib/allocation-vote/vote-message";
import { verifyVoteSignature } from "@/lib/allocation-vote/vote-verify";

export const VOTE_MIGRATION_PATH = path.resolve(__dirname, "../../../supabase/waitlist-migrations/20261108010000_perc_vote.sql");
export const RLS_MIGRATION_PATH = path.resolve(__dirname, "../../../supabase/waitlist-migrations/20261108020000_perc_private_rls.sql");

const bin = findPgBin();
if (!bin) console.warn("[perc-vote-db] SKIPPED: no local Postgres binaries (set PERC_ALLOC_PG_BIN)");
const d = bin ? describe : describe.skip;

let cluster: Cluster;
let reader: Client;
const su = <T>(fn: (c: Client) => Promise<T>) => withClient(cluster.superUrl, fn);

const U64_MAX = 18_446_744_073_709_551_615n;
type Voter = { kp: nacl.SignKeyPair; owner: string; raw: bigint };
const mkVoter = (raw: bigint): Voter => {
  const kp = nacl.sign.keyPair();
  return { kp, owner: bs58.encode(kp.publicKey), raw };
};

let voters: Voter[];
let excluded: Voter;

/** Eligible voters are signing keypairs; balances include u64-max to prove exact sums. */
function voteSnapshot(tag: string, vs: Voter[], ex: Voter): ValidatedSnapshot {
  const floor = 60_000n;
  const each = floor / BigInt(vs.length);
  const holders: HolderRow[] = vs.map((v, i) => ({
    owner: v.owner,
    eligible: true,
    balanceRaw: v.raw,
    allocationCents: i === 0 ? floor - each * BigInt(vs.length - 1) : each,
    reasons: [],
    // In snapshot "a" the third voter is counted under an approved balance exception:
    // it must vote with exactly its stored balance, like any other eligible row.
    basis: tag === "a" && i === 2 ? ("exception" as const) : ("snapshot" as const),
  }));
  holders.push({ owner: ex.owner, eligible: false, balanceRaw: 9_999n, allocationCents: 0n, reasons: ["off-curve"], basis: "snapshot" });
  const exc = tag === "a" && vs.length > 2;
  return {
    meta: {
      label: `SYNTHETIC vote ${tag}`,
      snapshotDate: "2000-01-01",
      snapshotSlot: 1n,
      tokenDecimals: 6,
      fullRaiseCents: 300_000n,
      floorPercent: "20",
      floorCents: floor,
      eligibleCsvSha256: (tag === "a" ? "a" : "d").repeat(64),
      allHoldersCsvSha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      teamExclusionBasis: "SYNTHETIC",
      teamExclusionVerified: false,
      exceptionOwners: exc ? 1 : 0,
      exceptionBasis: exc ? "SYNTHETIC approved balance exception" : null,
      exceptionFilesSha256: exc ? ["7".repeat(64)] : [],
      baseManifestSha256: null,
    },
    holders,
    eligibleCount: vs.length,
    excludedCount: 1,
    eligibleRawTotal: vs.reduce((a, v) => a + v.raw, 0n),
  };
}

const KEY = syntheticKey("vote-default");
let keySeq = 0;
const freshKey = () => syntheticKey(`vote-${keySeq++}`);

async function start(c: Client = reader) {
  return (await c.query("select * from perc_vote.start_poll($1)", ["perc-fee-policy-2026-11"])).rows[0];
}
async function nonce(owner: string, choice: VoteChoice, key: Buffer = freshKey(), c: Client = reader) {
  return (await c.query("select * from perc_vote.issue_nonce($1, $2, $3)", [owner, choice, key])).rows[0];
}
type Cast = { owner: string; choice: VoteChoice; nonce: string; issued_at: string; expires_at: string; message: string; sig: Buffer };
function signed(v: Voter, choice: VoteChoice, n: { nonce: string; issued_at: string; expires_at: string }): Cast {
  const message = buildVoteMessage({ choice, wallet: v.owner, nonce: n.nonce, issuedAt: n.issued_at, expiresAt: n.expires_at });
  const sig = Buffer.from(nacl.sign.detached(Uint8Array.from(Buffer.from(message, "utf8")), v.kp.secretKey));
  return { owner: v.owner, choice, nonce: n.nonce, issued_at: n.issued_at, expires_at: n.expires_at, message, sig };
}
async function cast(x: Cast, key: Buffer = freshKey(), c: Client = reader) {
  const r = await c.query("select * from perc_vote.cast_vote($1, $2, $3, $4, $5, $6, $7, $8)", [
    x.owner, x.choice, x.nonce, x.issued_at, x.expires_at, x.message, x.sig, key,
  ]);
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
}
async function vote(v: Voter, choice: VoteChoice) {
  const n = await nonce(v.owner, choice);
  expect(n.outcome).toBe("ok");
  return cast(signed(v, choice, n));
}
async function tally(c: Client = reader) {
  return (await c.query("select * from perc_vote.tally($1)", [freshKey()])).rows[0];
}
/** Move the poll window (test-only superuser action; keeps the 24h invariant). */
async function shiftPoll(startOffset: string) {
  await su((c) =>
    c.query(`with t as (select clock_timestamp() + $1::interval as s)
             update perc_vote.poll set starts_at = t.s, ends_at = t.s + interval '24 hours' from t`, [startOffset]),
  );
}
/** Close the poll by moving the window AND every ballot back by the same amount (relative order kept). */
async function closePoll() {
  await su(async (c) => {
    const r = await c.query(
      "select extract(epoch from (clock_timestamp() - starts_at + interval '24 hours 61 seconds'))::text as secs from perc_vote.poll",
    );
    if (r.rows.length !== 1) return;
    const secs = r.rows[0].secs as string;
    await c.query("update perc_vote.ballot set cast_at = cast_at - make_interval(secs => $1::float8)", [secs]);
    await c.query(
      "update perc_vote.poll set starts_at = starts_at - make_interval(secs => $1::float8), ends_at = ends_at - make_interval(secs => $1::float8)",
      [secs],
    );
  });
}

async function migrateVote() {
  // vote migration, then the RLS layer: every vote test runs with RLS enabled.
  for (const p of [VOTE_MIGRATION_PATH, RLS_MIGRATION_PATH]) {
    const sql = fs.readFileSync(p, "utf8");
    await withClient(cluster.migratorUrl, (c) => c.query(sql));
  }
}

d("perc_vote schema (local Postgres)", () => {
  beforeAll(async () => {
    cluster = await startCluster(bin!);
    await migrate(cluster);
    await migrateVote();
    voters = [mkVoter(U64_MAX), mkVoter(U64_MAX - 1n), mkVoter(3n), mkVoter(1_000_000n), mkVoter(1_000_000n)];
    excluded = mkVoter(1n);
    await withClient(cluster.migratorUrl, (c) => applySnapshot(c, voteSnapshot("a", voters, excluded)));
    reader = new Client({ connectionString: cluster.readerUrl });
    await reader.connect();
  }, 60_000);

  afterAll(async () => {
    await reader?.end().catch(() => {});
    cluster?.stop();
  });

  beforeEach(async () => {
    await su(async (c) => {
      await c.query("truncate perc_vote.ballot, perc_vote.nonce, perc_vote.poll restart identity cascade");
      await c.query("delete from perc_alloc.rate_limit");
    });
  });

  describe("migration + privileges", () => {
    it("is idempotent (re-applied by the non-superuser migrator) and leaves the vote NOT STARTED", async () => {
      await migrateVote();
      await migrate(cluster); // checker migration re-applied after the vote one still works
      expect((await su((c) => c.query("select count(*)::int as n from perc_vote.poll"))).rows[0].n).toBe(0);
      const s = (await reader.query("select * from perc_vote.status($1)", [KEY])).rows[0];
      expect(s).toMatchObject({ outcome: "ok", state: "not_started", poll_key: "perc-fee-policy-2026-11", starts_at: null, ends_at: null });
    });

    it("RLS is enabled on all 6 private tables with a definer-only policy; the checker lookup still works", async () => {
      const t = await su((c) =>
        c.query(`select n.nspname || '.' || c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as force
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname in ('perc_alloc', 'perc_vote') and c.relkind = 'r' order by 1`),
      );
      expect(t.rows).toEqual(
        ["perc_alloc.holder", "perc_alloc.rate_limit", "perc_alloc.snapshot", "perc_vote.ballot", "perc_vote.nonce", "perc_vote.poll"].map((x) => ({ t: x, rls: true, force: false })),
      );
      const p = await su((c) => c.query("select schemaname || '.' || tablename as t, policyname, roles::text[] as roles, cmd from pg_policies where schemaname in ('perc_alloc','perc_vote') order by 1"));
      expect(p.rows).toHaveLength(6);
      for (const r of p.rows) expect([r.policyname, r.roles, r.cmd]).toEqual(["perc_definer_only", ["perc_alloc_definer"], "ALL"]);
      // checker lookup through the definer, with RLS on, returns the eligible row
      const a = (await reader.query("select outcome, eligible, balance_raw from perc_alloc.check_allocation($1::text, $2::bytea)", [voters[2]!.owner, KEY])).rows[0];
      expect(a).toMatchObject({ outcome: "eligible", eligible: true, balance_raw: "3" });
      // re-applying the RLS layer is a no-op (no duplicate policies)
      await withClient(cluster.migratorUrl, (c) => c.query(fs.readFileSync(RLS_MIGRATION_PATH, "utf8")));
      expect((await su((c) => c.query("select count(*)::int as n from pg_policies where schemaname in ('perc_alloc','perc_vote')"))).rows[0].n).toBe(6);
    });

    it("runtime role cannot read or write any vote/checker table, nor call helpers", async () => {
      for (const t of ["perc_vote.poll", "perc_vote.nonce", "perc_vote.ballot", "perc_alloc.holder"]) {
        await expect(reader.query(`select * from ${t} limit 1`)).rejects.toThrow(/permission denied/);
        await expect(reader.query(`delete from ${t}`)).rejects.toThrow(/permission denied/);
      }
      await expect(reader.query("select perc_vote._message('a','b','c','d','e','f')")).rejects.toThrow(/permission denied/);
      await expect(reader.query("select perc_alloc._hit($1, 60, 1, now())", [KEY])).rejects.toThrow(/permission denied/);
    });

    it("API roles (anon/authenticated/service_role) have no access to perc_vote", async () => {
      const r = await su((c) =>
        c.query(`select r, has_schema_privilege(r, 'perc_vote', 'USAGE') as u,
                        has_function_privilege(r, 'perc_vote.start_poll(text)', 'EXECUTE') as s,
                        has_function_privilege(r, 'perc_vote.cast_vote(text, text, text, text, text, text, bytea, bytea)', 'EXECUTE') as c
                   from unnest(array['anon','authenticated','service_role']) r`),
      );
      for (const row of r.rows) expect([row.u, row.s, row.c]).toEqual([false, false, false]);
    });

    it("the DB message template is byte-identical to the app's buildVoteMessage", async () => {
      const f = { choice: "weekly-fee-claims" as const, wallet: voters[0]!.owner, nonce: "ab".repeat(32), issuedAt: "2026-11-08T01:02:03.004Z", expiresAt: "2026-11-08T01:07:03.004Z" };
      const db = await su((c) =>
        c.query("select perc_vote._message('perc-fee-policy-2026-11', $1, $2, $3, $4, $5) as m", [f.choice, f.wallet, f.nonce, f.issuedAt, f.expiresAt]),
      );
      expect(db.rows[0].m).toBe(buildVoteMessage(f));
    });
  });

  describe("start: one-shot, exactly 24h, pinned to the active snapshot", () => {
    it("before start nothing can be voted and no nonce is issued", async () => {
      expect((await nonce(voters[0]!.owner, "buy-and-burn")).outcome).toBe("not_started");
      expect((await tally()).state).toBe("not_started");
    });

    it("start opens a 24h window from database time; a second start never restarts or extends it", async () => {
      const a = await start();
      expect(a.outcome).toBe("started");
      expect(Date.parse(a.ends_at) - Date.parse(a.starts_at)).toBe(24 * 3600 * 1000);
      const b = await start();
      expect(b).toMatchObject({ outcome: "already_started", starts_at: a.starts_at, ends_at: a.ends_at });
      expect((await su((c) => c.query("select count(*)::int as n from perc_vote.poll"))).rows[0].n).toBe(1);
    });

    it("concurrent starts create exactly one poll", async () => {
      const cs = await Promise.all(Array.from({ length: 6 }, async () => {
        const c = new Client({ connectionString: cluster.readerUrl });
        await c.connect();
        return c;
      }));
      try {
        const out = await Promise.all(cs.map((c) => start(c)));
        expect(out.filter((o) => o.outcome === "started")).toHaveLength(1);
        expect(out.filter((o) => o.outcome === "already_started")).toHaveLength(5);
      } finally {
        await Promise.all(cs.map((c) => c.end()));
      }
    });

    it("refuses any other poll key", async () => {
      expect((await reader.query("select * from perc_vote.start_poll($1)", ["other"])).rows[0].outcome).toBe("invalid");
      expect((await reader.query("select * from perc_vote.start_poll($1)", [null])).rows[0].outcome).toBe("invalid");
    });

    it("the poll row cannot be edited even by the definer (no UPDATE/DELETE grant)", async () => {
      const r = await su((c) =>
        c.query(`select has_table_privilege('perc_alloc_definer', 'perc_vote.poll', 'UPDATE') as u,
                        has_table_privilege('perc_alloc_definer', 'perc_vote.poll', 'DELETE') as d,
                        has_table_privilege('perc_alloc_definer', 'perc_vote.ballot', 'DELETE') as bd`),
      );
      expect(r.rows[0]).toEqual({ u: false, d: false, bd: false });
    });
  });

  describe("window boundaries (database clock)", () => {
    it("a future start time is not_started; just inside is open; at/after ends_at is closed", async () => {
      await start();
      await shiftPoll("1 hour");
      expect((await nonce(voters[0]!.owner, "buy-and-burn")).outcome).toBe("not_started");
      await shiftPoll("-1 second");
      expect((await nonce(voters[0]!.owner, "buy-and-burn")).outcome).toBe("ok");
      // 1s past ends_at: a zero-margin "exactly at ends_at" setup races the next
      // statement's clock under load (observed once); closed-at-ends_at is the
      // `v_now >= ends_at` rule, exercised with margin here.
      await shiftPoll("-24 hours -1 second");
      expect((await nonce(voters[0]!.owner, "buy-and-burn")).outcome).toBe("closed");
    });

    it("a nonce issued while open cannot be used once the window has closed", async () => {
      await start();
      const n = await nonce(voters[2]!.owner, "weekly-fee-claims");
      await closePoll();
      expect((await cast(signed(voters[2]!, "weekly-fee-claims", n))).outcome).toBe("closed");
      expect((await su((c) => c.query("select count(*)::int as n from perc_vote.ballot"))).rows[0].n).toBe(0);
    });

    it("nonce expiry never runs past the end of the window", async () => {
      await start();
      await shiftPoll("-23 hours -58 minutes"); // 2 minutes left
      const n = await nonce(voters[0]!.owner, "buy-and-burn");
      const ends = (await reader.query("select * from perc_vote.status($1)", [freshKey()])).rows[0].ends_at;
      expect(Date.parse(n.expires_at)).toBeLessThanOrEqual(Date.parse(ends));
    });
  });

  describe("nonces, binding and replay", () => {
    beforeEach(async () => {
      await start();
    });

    it("a genuinely signed vote with a fresh nonce is recorded and the signature persisted", async () => {
      const n = await nonce(voters[2]!.owner, "weekly-fee-claims");
      expect(n.message).toBe(buildVoteMessage({ choice: "weekly-fee-claims", wallet: voters[2]!.owner, nonce: n.nonce, issuedAt: n.issued_at, expiresAt: n.expires_at }));
      expect(Date.parse(n.expires_at) - Date.parse(n.issued_at)).toBe(5 * 60 * 1000);
      const x = signed(voters[2]!, "weekly-fee-claims", n);
      expect(verifyVoteSignature(x.owner, n.message, bs58.encode(x.sig))).not.toBeNull();
      const r = await cast(x);
      expect(r).toMatchObject({ outcome: "recorded", choice: "weekly-fee-claims", revision: 1 });
      const row = (await su((c) => c.query("select * from perc_vote.ballot"))).rows[0];
      expect(Buffer.compare(row.signature, x.sig)).toBe(0);
      expect(row.message).toBe(x.message);
      expect(row.nonce).toBe(n.nonce);
    });

    it("replaying a consumed nonce is refused", async () => {
      const n = await nonce(voters[2]!.owner, "weekly-fee-claims");
      const x = signed(voters[2]!, "weekly-fee-claims", n);
      expect((await cast(x)).outcome).toBe("recorded");
      expect((await cast(x)).outcome).toBe("bad_nonce");
    });

    it("concurrent replays of one nonce record exactly one vote", async () => {
      const n = await nonce(voters[3]!.owner, "buy-and-burn");
      const x = signed(voters[3]!, "buy-and-burn", n);
      const cs = await Promise.all(Array.from({ length: 12 }, async () => {
        const c = new Client({ connectionString: cluster.readerUrl });
        await c.connect();
        return c;
      }));
      try {
        const out = await Promise.all(cs.map((c, i) => cast(x, syntheticKey(`race-${i}`), c)));
        const outcomes = out.map((o) => o.outcome).sort();
        expect(outcomes.filter((o) => o === "recorded")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "bad_nonce")).toHaveLength(11);
      } finally {
        await Promise.all(cs.map((c) => c.end()));
      }
      const b = (await su((c) => c.query("select revision from perc_vote.ballot"))).rows;
      expect(b).toEqual([{ revision: 1 }]);
    });

    it("an expired nonce is refused", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      await su((c) => c.query("update perc_vote.nonce set issued_at = issued_at - interval '6 minutes', expires_at = expires_at - interval '6 minutes'"));
      const shifted = (await su((c) => c.query("select perc_vote._ts(issued_at) i, perc_vote._ts(expires_at) e from perc_vote.nonce"))).rows[0];
      expect((await cast(signed(voters[2]!, "buy-and-burn", { nonce: n.nonce, issued_at: shifted.i, expires_at: shifted.e }))).outcome).toBe("expired");
    });

    it("a nonce is bound to its choice: using it for the other choice is refused", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      expect((await cast(signed(voters[2]!, "weekly-fee-claims", n))).outcome).toBe("bad_nonce");
      // and it was not consumed by the refused attempt
      expect((await cast(signed(voters[2]!, "buy-and-burn", n))).outcome).toBe("recorded");
    });

    it("a nonce is bound to its wallet: another eligible wallet cannot use it", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      expect((await cast(signed(voters[3]!, "buy-and-burn", n))).outcome).toBe("bad_nonce");
    });

    it("tampered issued/expiry times are refused", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      const later = new Date(Date.parse(n.expires_at) + 3600_000).toISOString();
      expect((await cast(signed(voters[2]!, "buy-and-burn", { ...n, expires_at: later }))).outcome).toBe("bad_nonce");
    });

    it("a message for another domain/action/poll (or any edit) is refused even if signed", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      const good = signed(voters[2]!, "buy-and-burn", n);
      for (const evil of [
        good.message.replace("Domain: percolator.trade", "Domain: evil.example"),
        good.message.replace("Action: cast-vote", "Action: start"),
        good.message.replace("perc-fee-policy-2026-11", "perc-fee-policy-2099"),
        good.message + "\n",
      ]) {
        const sig = Buffer.from(nacl.sign.detached(Uint8Array.from(Buffer.from(evil, "utf8")), voters[2]!.kp.secretKey));
        expect((await cast({ ...good, message: evil, sig })).outcome).toBe("message_mismatch");
      }
      expect((await cast(good)).outcome).toBe("recorded");
    });

    it("unknown nonce and malformed inputs are refused", async () => {
      const n = await nonce(voters[2]!.owner, "buy-and-burn");
      const x = signed(voters[2]!, "buy-and-burn", n);
      expect((await cast({ ...signed(voters[2]!, "buy-and-burn", { ...n, nonce: "f".repeat(64) }) })).outcome).toBe("bad_nonce");
      expect((await cast({ ...x, sig: Buffer.alloc(63) })).outcome).toBe("invalid");
      expect((await cast({ ...x, nonce: "Z".repeat(64) })).outcome).toBe("invalid");
      expect((await cast({ ...x, choice: "abstain" as VoteChoice })).outcome).toBe("invalid");
      expect((await cast({ ...x, owner: "0OIl" })).outcome).toBe("invalid");
      expect((await nonce("not-a-wallet", "buy-and-burn")).outcome).toBe("invalid");
    });
  });

  describe("eligibility", () => {
    beforeEach(async () => {
      await start();
    });

    it("excluded and unknown wallets get no nonce", async () => {
      expect((await nonce(excluded.owner, "buy-and-burn")).outcome).toBe("not_eligible");
      expect((await nonce(mkVoter(1n).owner, "buy-and-burn")).outcome).toBe("not_eligible");
      expect((await nonce(syntheticOwner("unknown"), "weekly-fee-claims")).outcome).toBe("not_eligible");
    });

    it("the poll keeps its pinned snapshot when a new snapshot is activated later", async () => {
      const newcomer = mkVoter(5n);
      await withClient(cluster.migratorUrl, (c) => applySnapshot(c, voteSnapshot("b", [newcomer], voters[0]!)));
      try {
        expect((await nonce(newcomer.owner, "buy-and-burn")).outcome).toBe("not_eligible");
        expect((await vote(voters[2]!, "buy-and-burn")).outcome).toBe("recorded");
      } finally {
        await su(async (c) => {
          await c.query("update perc_alloc.snapshot set is_active = false");
          await c.query("update perc_alloc.snapshot set is_active = true where label = 'SYNTHETIC vote a'");
        });
      }
    });
  });

  describe("one row per wallet; last valid vote wins", () => {
    beforeEach(async () => {
      await start();
    });

    it("changing a vote replaces the row and bumps the revision", async () => {
      expect(await vote(voters[2]!, "weekly-fee-claims")).toMatchObject({ outcome: "recorded", revision: 1 });
      expect(await vote(voters[2]!, "buy-and-burn")).toMatchObject({ outcome: "recorded", revision: 2, choice: "buy-and-burn" });
      expect(await vote(voters[2]!, "weekly-fee-claims")).toMatchObject({ outcome: "recorded", revision: 3 });
      const rows = (await su((c) => c.query("select choice, revision from perc_vote.ballot"))).rows;
      expect(rows).toEqual([{ choice: "weekly-fee-claims", revision: 3 }]);
    });

    it("concurrent votes from one wallet with different nonces leave one row matching the latest cast", async () => {
      const ns = await Promise.all(["weekly-fee-claims", "buy-and-burn", "weekly-fee-claims", "buy-and-burn"].map((ch) => nonce(voters[4]!.owner, ch as VoteChoice).then((n) => ({ n, ch: ch as VoteChoice }))));
      const cs = await Promise.all(ns.map(async () => {
        const c = new Client({ connectionString: cluster.readerUrl });
        await c.connect();
        return c;
      }));
      try {
        const out = await Promise.all(ns.map(({ n, ch }, i) => cast(signed(voters[4]!, ch, n), freshKey(), cs[i])));
        expect(out.every((o) => o.outcome === "recorded" || o.outcome === "superseded")).toBe(true);
        const recorded = out.filter((o) => o.outcome === "recorded");
        const rows = (await su((c) => c.query("select choice, revision, perc_vote._ts(cast_at) as at from perc_vote.ballot"))).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].revision).toBe(recorded.length);
        const latest = recorded.reduce((a, b) => (Date.parse(b.cast_at) >= Date.parse(a.cast_at) ? b : a));
        expect(rows[0].choice).toBe(latest.choice);
      } finally {
        await Promise.all(cs.map((c) => c.end()));
      }
    });
  });

  describe("tally: exact, aggregate only, after close", () => {
    beforeEach(async () => {
      await start();
    });

    it("is hidden while open", async () => {
      await vote(voters[2]!, "weekly-fee-claims");
      const t = await tally();
      expect(t).toMatchObject({ state: "open", weekly_fee_claims_raw: null, buy_and_burn_raw: null, winner: null });
    });

    it("within 60 s after ends_at the result is 'tallying' with no figures (in-flight casts may still commit)", async () => {
      await vote(voters[0]!, "weekly-fee-claims");
      await shiftPoll("-24 hours -5 seconds");
      expect(await tally()).toMatchObject({ state: "tallying", weekly_fee_claims_raw: null, buy_and_burn_raw: null, winner: null });
      expect((await nonce(voters[1]!.owner, "buy-and-burn")).outcome).toBe("closed");
    });

    it("zero votes -> buy-and-burn", async () => {
      await closePoll();
      expect(await tally()).toMatchObject({ state: "closed", weekly_fee_claims_raw: "0", buy_and_burn_raw: "0", weekly_fee_claims_wallets: 0, buy_and_burn_wallets: 0, winner: "buy-and-burn" });
    });

    it("balance weighted, not wallet counted: one large holder beats many small", async () => {
      await vote(voters[0]!, "weekly-fee-claims");
      await vote(voters[2]!, "buy-and-burn");
      await vote(voters[3]!, "buy-and-burn");
      await vote(voters[4]!, "buy-and-burn");
      await closePoll();
      const t = await tally();
      expect(t.weekly_fee_claims_raw).toBe(U64_MAX.toString());
      expect(t.buy_and_burn_raw).toBe("2000003");
      expect([t.weekly_fee_claims_wallets, t.buy_and_burn_wallets]).toEqual([1, 3]);
      expect(t.winner).toBe("weekly-fee-claims");
    });

    it("exact tie -> buy-and-burn", async () => {
      await vote(voters[3]!, "weekly-fee-claims");
      await vote(voters[4]!, "buy-and-burn");
      await closePoll();
      expect(await tally()).toMatchObject({ weekly_fee_claims_raw: "1000000", buy_and_burn_raw: "1000000", winner: "buy-and-burn" });
    });

    it("precision: sums beyond 2^64 are exact and a 1-unit margin decides", async () => {
      // fee: U64_MAX + 3 ; burn: (U64_MAX - 1) + 1_000_000 + 1_000_000 -> burn wins by 1_999_996
      await vote(voters[0]!, "weekly-fee-claims");
      await vote(voters[2]!, "weekly-fee-claims");
      await vote(voters[1]!, "buy-and-burn");
      await vote(voters[3]!, "buy-and-burn");
      await vote(voters[4]!, "buy-and-burn");
      await closePoll();
      const t = await tally();
      // voters[2] (balance 3) is an exception-basis row: counted at exactly its stored balance
      expect(t.weekly_fee_claims_raw).toBe((U64_MAX + 3n).toString());
      expect(t.buy_and_burn_raw).toBe((U64_MAX - 1n + 2_000_000n).toString());
      expect(t.winner).toBe("buy-and-burn");
      expect(t.eligible_raw_total).toBe(voters.reduce((a, v) => a + v.raw, 0n).toString());
      expect(t.eligible_wallets).toBe(voters.length);
    });

    it("a ballot whose database time is at/after ends_at is not counted", async () => {
      await vote(voters[0]!, "weekly-fee-claims");
      await shiftPoll("-24 hours -61 seconds"); // window ended (past the grace period) before the ballot's cast_at
      expect(await tally()).toMatchObject({ state: "closed", weekly_fee_claims_raw: "0", winner: "buy-and-burn" });
    });

    it("only the final vote of a wallet counts", async () => {
      await vote(voters[0]!, "weekly-fee-claims");
      await vote(voters[0]!, "buy-and-burn");
      await closePoll();
      expect(await tally()).toMatchObject({ weekly_fee_claims_raw: "0", buy_and_burn_raw: U64_MAX.toString(), winner: "buy-and-burn" });
    });
  });

  describe("rate limiting (durable, per client, inside the database)", () => {
    it("nonce issue is limited per client key and reports retry seconds", async () => {
      await start();
      const k = freshKey();
      const outs = [];
      for (let i = 0; i < 21; i++) outs.push((await nonce(voters[2]!.owner, "buy-and-burn", k)).outcome);
      expect(outs.slice(0, 20).every((o) => o === "ok")).toBe(true);
      const last = await nonce(voters[2]!.owner, "buy-and-burn", k);
      expect(last.outcome).toBe("rate_limited");
      expect(last.retry_after_seconds).toBeGreaterThan(0);
      // a different client is unaffected (no per-wallet lockout by strangers)
      expect((await nonce(voters[2]!.owner, "buy-and-burn", freshKey())).outcome).toBe("ok");
    });

    it("submit gate allows 20 attempts per client per minute; another client is unaffected", async () => {
      const k = freshKey();
      const r = [];
      for (let i = 0; i < 21; i++) r.push((await reader.query("select perc_vote.submit_gate($1) as r", [k])).rows[0].r);
      expect(r.slice(0, 20).every((x) => x === 0)).toBe(true);
      expect(r[20]).toBeGreaterThan(0);
      expect((await reader.query("select perc_vote.submit_gate($1) as r", [freshKey()])).rows[0].r).toBe(0);
    });

    it("cast is limited per wallet (20 per 10 minutes) - reachable only with the wallet's own signature", async () => {
      await start();
      const outs = [];
      for (let i = 0; i < 21; i++) outs.push((await vote(voters[3]!, i % 2 ? "buy-and-burn" : "weekly-fee-claims")).outcome);
      expect(outs.slice(0, 20).every((o) => o === "recorded")).toBe(true);
      expect(outs[20]).toBe("rate_limited");
    });

    it("one client exhausting its admin attempts cannot lock out another client (no global admin bucket)", async () => {
      const attacker = freshKey();
      for (let i = 0; i < 40; i++) await reader.query("select perc_vote.admin_gate($1)", [attacker]);
      expect((await reader.query("select perc_vote.admin_gate($1) as r", [freshKey()])).rows[0].r).toBe(0);
    });

    it("expired rate-limit buckets are purged by vote calls", async () => {
      await su((c) => c.query("insert into perc_alloc.rate_limit values (sha256('old-bucket'::bytea), now() - interval '2 hours', 1, now() - interval '1 hour')"));
      await reader.query("select perc_vote.submit_gate($1)", [freshKey()]);
      const n = (await su((c) => c.query("select count(*)::int as n from perc_alloc.rate_limit where bucket = sha256('old-bucket'::bytea)"))).rows[0].n;
      expect(n).toBe(0);
    });

    it("admin gate allows 5 attempts per client per 15 minutes", async () => {
      const k = freshKey();
      const r = [];
      for (let i = 0; i < 6; i++) r.push((await reader.query("select perc_vote.admin_gate($1) as r", [k])).rows[0].r);
      expect(r.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
      expect(r[5]).toBeGreaterThan(0);
      expect((await reader.query("select perc_vote.admin_gate($1) as r", [Buffer.alloc(3)])).rows[0].r).toBeGreaterThan(0);
    });
  });
});
