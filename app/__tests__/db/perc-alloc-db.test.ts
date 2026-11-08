/**
 * PERC allocation private schema, against a throwaway local Postgres.
 *
 *  - the runtime role can do exactly one thing: call perc_alloc.check_allocation
 *  - one owner per call, parameterized, exact balance + integer cents
 *  - durable, atomic, hashed-key rate limiting with expiry
 *  - imports are atomic and supersede (never delete) the previous snapshot
 *
 * All data is SYNTHETIC. Skipped when no local Postgres binaries are found.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { findPgBin, migrate, startCluster, withClient, type Cluster } from "./pg-harness";
import { syntheticKey, syntheticOwner, syntheticSnapshot } from "./synthetic";
import { applySnapshot } from "@/scripts/allocation/import-lib";

const bin = findPgBin();
if (!bin) console.warn("[perc-alloc-db] SKIPPED: no local Postgres binaries (set PERC_ALLOC_PG_BIN)");
const d = bin ? describe : describe.skip;

let cluster: Cluster;
let reader: Client;

const CHECK =
  "select outcome, retry_after_seconds, eligible, balance_raw, token_decimals, allocation_usd_cents::text as allocation_usd_cents, exclusion_reasons, snapshot_label, allocation_status, balance_basis from perc_alloc.check_allocation($1::text, $2::bytea)";

async function check(owner: unknown, key: Buffer | null = syntheticKey("default"), c: Client = reader) {
  const r = await c.query(CHECK, [owner, key]);
  expect(r.rows).toHaveLength(1);
  return r.rows[0];
}

const su = <T>(fn: (c: Client) => Promise<T>) => withClient(cluster.superUrl, fn);
const resetLimits = () => su((c) => c.query("delete from perc_alloc.rate_limit"));

async function importSynthetic(tag = "a") {
  return withClient(cluster.migratorUrl, (c) => applySnapshot(c, syntheticSnapshot(tag)));
}

d("perc_alloc schema (local Postgres)", () => {
  beforeAll(async () => {
    cluster = await startCluster(bin!);
    await migrate(cluster);
    reader = new Client({ connectionString: cluster.readerUrl });
    await reader.connect();
  }, 60_000);

  afterAll(async () => {
    await reader?.end().catch(() => {});
    cluster?.stop();
  });

  beforeEach(resetLimits);

  describe("migration", () => {
    it("is idempotent (second apply as the non-superuser migrator succeeds)", async () => {
      await migrate(cluster);
    });

    it("was applied by a non-superuser (Supabase-like) role", async () => {
      const r = await withClient(cluster.migratorUrl, (c) => c.query("select rolsuper from pg_roles where rolname = current_user"));
      expect(r.rows[0].rolsuper).toBe(false);
    });

    it("tables have no raw-IP or owner column in the limiter", async () => {
      const r = await su((c) =>
        c.query(
          "select column_name, data_type from information_schema.columns where table_schema='perc_alloc' and table_name='rate_limit' order by ordinal_position",
        ),
      );
      expect(r.rows.map((x) => x.column_name)).toEqual(["bucket", "window_start", "hits", "expires_at"]);
      expect(r.rows[0].data_type).toBe("bytea");
    });

    it("stores balances as exact numeric and allocations as integer cents", async () => {
      const r = await su((c) =>
        c.query(
          "select column_name, data_type, numeric_precision, numeric_scale from information_schema.columns where table_schema='perc_alloc' and table_name='holder'",
        ),
      );
      const col = Object.fromEntries(r.rows.map((x) => [x.column_name, x]));
      expect(col.balance_raw).toMatchObject({ data_type: "numeric", numeric_precision: 20, numeric_scale: 0 });
      expect(col.allocation_usd_cents.data_type).toBe("bigint");
    });
  });

  describe("runtime role is least-privilege", () => {
    it("is not superuser, cannot create roles/dbs, cannot bypass RLS", async () => {
      const r = await su((c) =>
        c.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication from pg_roles where rolname='perc_alloc_reader'"),
      );
      expect(r.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false });
    });

    it.each(["perc_alloc.holder", "perc_alloc.snapshot", "perc_alloc.rate_limit"])("cannot SELECT %s", async (t) => {
      await expect(reader.query(`select * from ${t} limit 1`)).rejects.toThrow(/permission denied/);
    });

    it.each([
      "insert into perc_alloc.rate_limit values ('\\x00', now(), 0, now())",
      "delete from perc_alloc.rate_limit",
      "update perc_alloc.snapshot set is_active = false",
      "truncate perc_alloc.holder",
      "create table perc_alloc.x (a int)",
    ])("cannot write: %s", async (sql) => {
      await expect(reader.query(sql)).rejects.toThrow(/permission denied/);
    });

    it("cannot call the internal limiter helper", async () => {
      await expect(
        reader.query("select perc_alloc._hit($1::bytea, 60, 10, now())", [Buffer.alloc(32)]),
      ).rejects.toThrow(/permission denied/);
    });

    it("has EXECUTE on exactly one perc_alloc function", async () => {
      const r = await su((c) =>
        c.query(
          `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'perc_alloc' and has_function_privilege('perc_alloc_reader', p.oid, 'EXECUTE') order by 1`,
        ),
      );
      expect(r.rows.map((x) => x.proname)).toEqual(["check_allocation"]);
    });

    it("the harness really applies Supabase-style default ACLs (so the next assertions are not vacuous)", async () => {
      const r = await su((c) => c.query("select count(*)::int as n from pg_default_acl d join pg_roles r on r.oid = d.defaclrole where r.rolname = 'migrator'"));
      expect(r.rows[0].n).toBe(3);
    });

    it.each(["anon", "authenticated", "service_role"])("%s has no access to the schema or its functions", async (role) => {
      const r = await su((c) =>
        c.query(
          `select has_schema_privilege($1, 'perc_alloc', 'USAGE') as usage,
                  has_function_privilege($1, 'perc_alloc.check_allocation(text, bytea)', 'EXECUTE') as exec,
                  has_function_privilege($1, 'perc_alloc._hit(bytea, integer, integer, timestamptz)', 'EXECUTE') as hit,
                  has_table_privilege($1, 'perc_alloc.holder', 'SELECT') as sel`,
          [role],
        ),
      );
      expect(r.rows[0]).toEqual({ usage: false, exec: false, hit: false, sel: false });
    });

    it("the definer that owns the function is NOLOGIN and cannot touch other schemas' writes", async () => {
      const r = await su((c) =>
        c.query(
          `select r.rolname, r.rolcanlogin, r.rolsuper from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           join pg_roles r on r.oid = p.proowner where n.nspname='perc_alloc' and p.proname='check_allocation'`,
        ),
      );
      expect(r.rows[0]).toEqual({ rolname: "perc_alloc_definer", rolcanlogin: false, rolsuper: false });
      const w = await su((c) =>
        c.query("select has_table_privilege('perc_alloc_definer', 'perc_alloc.holder', 'INSERT') as ins, has_table_privilege('perc_alloc_definer', 'perc_alloc.holder', 'SELECT') as sel"),
      );
      expect(w.rows[0]).toEqual({ ins: false, sel: true });
    });

    it("has a statement timeout", async () => {
      const r = await reader.query("show statement_timeout");
      expect(r.rows[0].statement_timeout).toBe("3s");
    });
  });

  describe("check_allocation", () => {
    it("is 'unavailable' when no snapshot is active (no fabricated figures)", async () => {
      const row = await check(syntheticOwner("a-e1"));
      expect(row).toMatchObject({ outcome: "unavailable", eligible: null, balance_raw: null, allocation_usd_cents: null });
    });

    it("returns the exact row for each eligible owner", async () => {
      await importSynthetic("a");
      const expected = [
        ["a-e1", "1000001", "10000"],
        ["a-e2", "2000002", "20000"],
        ["a-e3", "3000003", "30000"],
      ];
      for (const [tag, bal, cents] of expected) {
        const row = await check(syntheticOwner(tag!));
        expect(row).toEqual({
          outcome: "eligible",
          retry_after_seconds: 0,
          eligible: true,
          balance_raw: bal,
          token_decimals: 6,
          allocation_usd_cents: cents,
          exclusion_reasons: [],
          snapshot_label: "SYNTHETIC 1 Jan 2000",
          allocation_status: "provisional",
          balance_basis: "snapshot",
        });
      }
    });

    it("returns the known exclusion reasons for an excluded owner, with no allocation", async () => {
      const row = await check(syntheticOwner("a-x1"));
      expect(row).toMatchObject({
        outcome: "excluded",
        eligible: false,
        balance_raw: "5",
        allocation_usd_cents: null,
        exclusion_reasons: ["off-curve", "LP"],
      });
    });

    it("a valid but unknown owner is not_found with NO balance or allocation (never a zero)", async () => {
      const row = await check(syntheticOwner("nobody"));
      expect(row).toMatchObject({ outcome: "not_found", eligible: null, balance_raw: null, allocation_usd_cents: null, exclusion_reasons: null });
      expect(row.snapshot_label).toBe("SYNTHETIC 1 Jan 2000");
    });

    it.each([
      ["sql injection", "x' or '1'='1"],
      ["wildcard", "%"],
      ["too short", "1".repeat(31)],
      ["too long", "1".repeat(45)],
      ["bad charset", "0".repeat(40)],
      ["comma batch", `${syntheticOwner("a-e1")},${syntheticOwner("a-e2")}`],
      ["empty", ""],
      ["null", null],
    ])("rejects %s as invalid, without consuming a lookup", async (_l, v) => {
      const row = await check(v);
      expect(row).toMatchObject({ outcome: "invalid", balance_raw: null });
      const n = await su((c) => c.query("select count(*)::int as n from perc_alloc.holder"));
      expect(n.rows[0].n).toBeGreaterThan(0);
      // nothing was counted against any limiter bucket
      const rl = await su((c) => c.query("select count(*)::int as n from perc_alloc.rate_limit"));
      expect(rl.rows[0].n).toBe(0);
    });

    it.each([
      ["null key", null],
      ["short key", Buffer.alloc(31)],
      ["long key", Buffer.alloc(33)],
    ])("rejects %s as invalid", async (_l, key) => {
      expect((await check(syntheticOwner("a-e1"), key as Buffer | null)).outcome).toBe("invalid");
    });

    it("an array parameter cannot be passed as the owner", async () => {
      // node-postgres serializes JS arrays to a Postgres array literal ("{...}"), which fails the owner pattern:
      const row = (await reader.query(CHECK, [[syntheticOwner("a-e1"), syntheticOwner("a-e2")], syntheticKey(2)])).rows[0];
      expect(row.outcome).toBe("invalid");
    });
  });

  describe("rate limiting (durable, atomic, hashed keys)", () => {
    it("allows 10 per client per minute, then reports retry_after", async () => {
      const key = syntheticKey("rl-1");
      for (let i = 0; i < 10; i++) expect((await check(syntheticOwner("a-e1"), key)).outcome).toBe("eligible");
      const row = await check(syntheticOwner("a-e1"), key);
      expect(row.outcome).toBe("rate_limited");
      expect(row.retry_after_seconds).toBeGreaterThanOrEqual(1);
      expect(row.retry_after_seconds).toBeLessThanOrEqual(60);
      expect(row.balance_raw).toBeNull();
      // invalid-owner calls are rejected before the limiter and so stay free; a different client is unaffected
      expect((await check(syntheticOwner("a-e1"), syntheticKey("rl-other"))).outcome).toBe("eligible");
    });

    it("unknown wallets count against the limit too (enumeration costs the same)", async () => {
      const key = syntheticKey("rl-unknown");
      for (let i = 0; i < 10; i++) expect((await check(syntheticOwner(`nobody-${i}`), key)).outcome).toBe("not_found");
      expect((await check(syntheticOwner("nobody-x"), key)).outcome).toBe("rate_limited");
    });

    it("is atomic under concurrency: 40 parallel calls from 8 connections -> exactly 10 served", async () => {
      const key = syntheticKey("rl-concurrent");
      const clients = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const c = new Client({ connectionString: cluster.readerUrl });
          await c.connect();
          return c;
        }),
      );
      try {
        const rows = await Promise.all(Array.from({ length: 40 }, (_, i) => check(syntheticOwner("a-e2"), key, clients[i % 8])));
        const served = rows.filter((r) => r.outcome === "eligible").length;
        expect(served).toBe(10);
        expect(rows.filter((r) => r.outcome === "rate_limited").length).toBe(30);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
    });

    it("window expiry re-opens the client; the hourly cap (60 attempts, denied ones included) still binds", async () => {
      const key = syntheticKey("rl-hour");
      for (let w = 0; w < 6; w++) {
        for (let i = 0; i < 10; i++) expect((await check(syntheticOwner("a-e3"), key)).outcome).toBe("eligible");
        // simulate the minute passing for the minute buckets only (hour buckets have expires_at > now + 2 min)
        await su((c) =>
          c.query("update perc_alloc.rate_limit set expires_at = now() - interval '1 second' where expires_at < now() + interval '2 minutes' and bucket <> sha256('perc_alloc:global:60'::bytea)"),
        );
      }
      const row = await check(syntheticOwner("a-e3"), key);
      expect(row.outcome).toBe("rate_limited");
      expect(row.retry_after_seconds).toBeGreaterThan(60);
    });

    it("global cap: 600 per minute across all clients", async () => {
      for (let i = 0; i < 600; i++) expect((await check(syntheticOwner("a-e1"), syntheticKey(`g-${i}`))).outcome).toBe("eligible");
      expect((await check(syntheticOwner("a-e1"), syntheticKey("g-600"))).outcome).toBe("rate_limited");
    }, 60_000);

    it("buckets are 32-byte hashes, never the client key or owner itself", async () => {
      const key = syntheticKey("rl-hash");
      await check(syntheticOwner("a-e1"), key);
      const r = await su((c) => c.query("select bucket from perc_alloc.rate_limit"));
      for (const { bucket } of r.rows) {
        expect(bucket.length).toBe(32);
        expect(Buffer.compare(bucket, key)).not.toBe(0);
      }
    });

    it("expired rows are cleaned up by later calls", async () => {
      await check(syntheticOwner("a-e1"), syntheticKey("rl-gc"));
      await su((c) => c.query("update perc_alloc.rate_limit set expires_at = now() - interval '1 hour'"));
      await check(syntheticOwner("a-e1"), syntheticKey("rl-gc-2"));
      const r = await su((c) => c.query("select count(*)::int as n from perc_alloc.rate_limit where expires_at < now()"));
      expect(r.rows[0].n).toBe(0);
    });
  });

  describe("import: atomic, superseding, constraint-checked", () => {
    it("a second import supersedes (keeps) the first; exactly one active", async () => {
      const res = await importSynthetic("b");
      expect(res.superseded.length).toBe(1);
      const s = await su((c) => c.query("select id, is_active, superseded_at is not null as sup from perc_alloc.snapshot order by id"));
      expect(s.rows.filter((x) => x.is_active)).toHaveLength(1);
      expect(s.rows[0]).toMatchObject({ is_active: false, sup: true });
      // the old snapshot's owners are now unknown to the live lookup; history rows still exist
      expect((await check(syntheticOwner("a-e1"))).outcome).toBe("not_found");
      expect((await check(syntheticOwner("b-e1"))).outcome).toBe("eligible");
      const hist = await su((c) => c.query("select count(*)::int as n from perc_alloc.holder where snapshot_id = $1", [s.rows[0].id]));
      expect(hist.rows[0].n).toBe(5);
    });

    it("a failing import changes nothing (previous snapshot stays active)", async () => {
      const bad = syntheticSnapshot("c");
      bad.holders[0]!.allocationCents += 1n; // sum no longer equals the floor
      await expect(withClient(cluster.migratorUrl, (c) => applySnapshot(c, bad))).rejects.toThrow(/verification failed/i);
      expect((await check(syntheticOwner("b-e1"))).outcome).toBe("eligible");
      expect((await check(syntheticOwner("c-e1"))).outcome).toBe("not_found");
      const n = await su((c) => c.query("select count(*)::int as n from perc_alloc.snapshot"));
      expect(n.rows[0].n).toBe(2);
    });

    it.each([
      ["eligible with a reason", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[0]!.reasons = ["LP"])],
      ["excluded with an allocation", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[3]!.allocationCents = 1n)],
      ["excluded without a reason", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[3]!.reasons = [])],
      ["unknown reason code", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[3]!.reasons = ["team"])],
      ["zero balance", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[4]!.balanceRaw = 0n)],
      ["balance above u64", (h: ReturnType<typeof syntheticSnapshot>) => (h.holders[4]!.balanceRaw = 18446744073709551616n)],
    ])("database constraints reject %s", async (_l, mutate) => {
      const s = syntheticSnapshot("d");
      mutate(s);
      await expect(withClient(cluster.migratorUrl, (c) => applySnapshot(c, s))).rejects.toThrow();
      expect((await check(syntheticOwner("b-e1"))).outcome).toBe("eligible");
    });

    it("the runtime role cannot import", async () => {
      await expect(applySnapshot(reader, syntheticSnapshot("e"))).rejects.toThrow(/permission denied/);
    });

    it("re-running the exact active inputs is a no-op (no new snapshot)", async () => {
      const before = await su((c) => c.query("select id from perc_alloc.snapshot where is_active"));
      const b = syntheticSnapshot("b");
      const res = await withClient(cluster.migratorUrl, (c) => applySnapshot(c, b));
      expect(res).toMatchObject({ unchanged: true, superseded: [], snapshotId: before.rows[0].id });
      const n = await su((c) => c.query("select count(*)::int as n from perc_alloc.snapshot"));
      expect(n.rows[0].n).toBe(2);
    });

    it("same files but a corrected snapshot slot is NOT a no-op: it is re-imported and activated", async () => {
      const b = syntheticSnapshot("b");
      b.meta.snapshotSlot = 2n;
      const res = await withClient(cluster.migratorUrl, (c) => applySnapshot(c, b));
      expect(res.unchanged).toBe(false);
      const a = await su((c) => c.query("select snapshot_slot::text as slot from perc_alloc.snapshot where is_active"));
      expect(a.rows[0].slot).toBe("2");
      // and re-running that is now the no-op
      expect((await withClient(cluster.migratorUrl, (c) => applySnapshot(c, b))).unchanged).toBe(true);
    });

    it("replacement with re-divided shares + an added exception owner: atomic, no stale figures", async () => {
      // Same owner tags as the active snapshot "b" but new hashes and new figures.
      const next = syntheticSnapshot("b", { exception: true });
      next.meta.eligibleCsvSha256 = "f".repeat(64);
      next.holders[0]!.allocationCents = 9_000n;
      next.holders[1]!.allocationCents = 21_000n;
      const res = await withClient(cluster.migratorUrl, (c) => applySnapshot(c, next));
      expect(res.unchanged).toBe(false);
      expect(res.superseded).toHaveLength(1);
      expect(await check(syntheticOwner("b-e1"))).toMatchObject({ outcome: "eligible", allocation_usd_cents: "9000", balance_basis: "snapshot" });
      expect(await check(syntheticOwner("b-e2"))).toMatchObject({ outcome: "eligible", allocation_usd_cents: "21000" });
      expect(await check(syntheticOwner("b-e3"))).toMatchObject({ outcome: "eligible", allocation_usd_cents: "30000", balance_basis: "exception" });
      expect(await check(syntheticOwner("b-x1"))).toMatchObject({ outcome: "excluded", balance_basis: "snapshot" });
      expect((await check(syntheticOwner("b-zz"))).balance_basis).toBeNull();
      const s = await su((c) =>
        c.query("select exception_owners, exception_files_sha256, base_manifest_sha256, eligible_csv_sha256 from perc_alloc.snapshot where is_active"),
      );
      expect(s.rows[0]).toMatchObject({ exception_owners: 1, exception_files_sha256: ["d".repeat(64)], base_manifest_sha256: "e".repeat(64), eligible_csv_sha256: "f".repeat(64) });
    });

    it.each([
      ["an exception row the metadata does not declare", (s: ReturnType<typeof syntheticSnapshot>) => (s.holders[1]!.basis = "exception")],
      ["declared exceptions with no exception row", (s: ReturnType<typeof syntheticSnapshot>) => (s.holders[2]!.basis = "snapshot")],
      ["a duplicate owner", (s: ReturnType<typeof syntheticSnapshot>) => (s.holders[1]!.owner = s.holders[0]!.owner)],
      ["exception basis on an excluded owner", (s: ReturnType<typeof syntheticSnapshot>) => (s.holders[3]!.basis = "exception")],
      ["exception count without provenance", (s: ReturnType<typeof syntheticSnapshot>) => (s.meta.exceptionBasis = null)],
    ])("a replacement with %s is refused and the active snapshot is untouched", async (_l, mutate) => {
      const active = await su((c) => c.query("select id from perc_alloc.snapshot where is_active"));
      const s = syntheticSnapshot("g", { exception: true });
      mutate(s);
      await expect(withClient(cluster.migratorUrl, (c) => applySnapshot(c, s))).rejects.toThrow();
      const after = await su((c) => c.query("select id from perc_alloc.snapshot where is_active"));
      expect(after.rows[0].id).toBe(active.rows[0].id);
      expect((await check(syntheticOwner("g-e1"))).outcome).toBe("not_found");
    });
  });
});
