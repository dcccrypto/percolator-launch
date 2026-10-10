// @vitest-environment node
/**
 * Review M-7: the keeper enrollment guard, over REAL devnet slab bytes (fixtures/relaunch/m7-slabs.json,
 * wrapper ETDLAdiA... at 553d76f0) plus single-field mutations of them, and the enrollment caps.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  checkEnrollmentCaps,
  checkKeeperReadiness,
  enrollmentCapsFromEnv,
  readinessStatus,
  GLOBAL_CAP_COPY,
  PER_CREATOR_CAP_COPY,
  DEFAULT_MAX_ACTIVE_MARKETS,
  DEFAULT_MAX_ACTIVE_PER_CREATOR,
} from "@/lib/keeper-enrollment-guard";
import { upsertRegisteredMarketRow, type RegistrationRow } from "@/lib/market-registration";
import { KEEPER_REGISTER_COPY, userFacingRegistrationReason } from "@/lib/keeper-register-client";
import {
  C_TOT_OFF,
  FINISHED_SLAB,
  INSURANCE_OFF,
  liveSlab,
  M7_KEEPER,
  M7_STAKE_PROGRAM,
  ORACLE_AUTHORITY_OFF,
  ORACLE_MODE_OFF,
  readySlabFor,
  SLAB_9EPM,
  UNFINISHED_SLAB,
} from "../fixtures/relaunch/m7-slabs";

const check = (data: Uint8Array, slab: string, keeper: string | null = M7_KEEPER, stake: string | null = M7_STAKE_PROGRAM) =>
  checkKeeperReadiness(data, new PublicKey(slab), stake, keeper);

describe("checkKeeperReadiness — live devnet markets", () => {
  it("finished keeper-priced markets pass (CzKxVxPm, 9EPm)", () => {
    expect(check(liveSlab(FINISHED_SLAB), FINISHED_SLAB)).toEqual({ ok: true });
    expect(check(liveSlab(SLAB_9EPM), SLAB_9EPM)).toEqual({ ok: true });
  });

  it("A9u1KkM9 (an active row whose launch stopped before the stake pool, insurance 0) is refused", () => {
    expect(check(liveSlab(UNFINISHED_SLAB), UNFINISHED_SLAB)).toEqual({ ok: false, reason: "incomplete" });
    expect(readinessStatus("incomplete")).toBe(409);
  });

  it("a finished market's bytes under ANOTHER slab address are incomplete (marketauth is that slab's PDA)", () => {
    expect(check(liveSlab(FINISHED_SLAB), SLAB_9EPM)).toEqual({ ok: false, reason: "incomplete" });
    const other = Keypair.generate().publicKey.toBase58();
    expect(check(readySlabFor(other), other)).toEqual({ ok: true });
  });
});

describe("checkKeeperReadiness — each requirement, one field at a time", () => {
  const ready = () => liveSlab(FINISHED_SLAB);

  it("no insurance -> no-insurance (409)", () => {
    const b = ready();
    b.fill(0, INSURANCE_OFF, INSURANCE_OFF + 16);
    expect(check(b, FINISHED_SLAB)).toEqual({ ok: false, reason: "no-insurance" });
    expect(readinessStatus("no-insurance")).toBe(409);
  });

  it("no LP collateral (c_tot 0) -> no-liquidity (409)", () => {
    const b = ready();
    b.fill(0, C_TOT_OFF, C_TOT_OFF + 16);
    expect(check(b, FINISHED_SLAB)).toEqual({ ok: false, reason: "no-liquidity" });
  });

  it("oracle authority is not our keeper -> oracle-not-keeper (403, final)", () => {
    const b = ready();
    Keypair.generate().publicKey.toBuffer().copy(b, ORACLE_AUTHORITY_OFF);
    expect(check(b, FINISHED_SLAB)).toEqual({ ok: false, reason: "oracle-not-keeper" });
    expect(readinessStatus("oracle-not-keeper")).toBe(403);
  });

  it("asset 0 not in AUTH_MARK mode -> oracle-not-keeper", () => {
    const b = ready();
    expect(b[ORACLE_MODE_OFF]).toBe(3);
    b[ORACLE_MODE_OFF] = 0;
    expect(check(b, FINISHED_SLAB)).toEqual({ ok: false, reason: "oracle-not-keeper" });
  });

  it("truncated bytes -> unreadable (400); no keeper key or stake program -> unconfigured (503)", () => {
    expect(check(ready().subarray(0, 900), FINISHED_SLAB)).toEqual({ ok: false, reason: "unreadable" });
    expect(readinessStatus("unreadable")).toBe(400);
    expect(check(ready(), FINISHED_SLAB, null)).toEqual({ ok: false, reason: "unconfigured" });
    expect(check(ready(), FINISHED_SLAB, M7_KEEPER, null)).toEqual({ ok: false, reason: "unconfigured" });
    expect(readinessStatus("unconfigured")).toBe(503);
  });
});

/** Supabase double: the registration read + count queries (select(..., {count, head})) + writes. */
function fakeDb(opts: { existing?: Record<string, unknown> | null; active?: Array<{ slab: string; deployer: string }>; countError?: boolean }) {
  const writes: Array<{ op: string; payload: Record<string, unknown> }> = [];
  let countQueries = 0;
  const client = {
    from() {
      return {
        select(_cols: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) {
            countQueries++;
            const f: Array<[string, string, unknown]> = [];
            const q: Record<string, unknown> = {
              eq: (c: string, v: unknown) => (f.push(["eq", c, v]), q),
              neq: (c: string, v: unknown) => (f.push(["neq", c, v]), q),
              then: (res: (v: unknown) => void) => {
                if (opts.countError) return res({ count: null, error: { code: "57014", message: "timeout" } });
                const rows = (opts.active ?? []).filter((r) =>
                  f.every(([op, c, v]) => {
                    if (c === "network") return v === "devnet";
                    if (c === "keeper_status") return v === "active";
                    const val = c === "slab_address" ? r.slab : c === "deployer" ? r.deployer : undefined;
                    return op === "eq" ? val === v : val !== v;
                  }),
                );
                res({ count: rows.length, error: null });
              },
            };
            return q;
          }
          return { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.existing ?? null, error: null }) }) }) };
        },
        insert: async (payload: Record<string, unknown>) => (writes.push({ op: "insert", payload }), { error: null }),
        update(payload: Record<string, unknown>) {
          const q: Record<string, unknown> = {
            eq: () => q,
            select: async () => (writes.push({ op: "update", payload }), { data: [{ id: "1" }], error: null }),
            then: (res: (v: unknown) => void) => (writes.push({ op: "update", payload }), res({ error: null })),
          };
          return q;
        },
      };
    },
  };
  return { client: client as never, writes, get countQueries() { return countQueries; } };
}

const CREATOR = "9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa";
const row = (slab: string, deployer = CREATOR): RegistrationRow => ({
  slab_address: slab,
  mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
  symbol: "T",
  name: "T",
  decimals: 6,
  deployer,
  dex_pool_address: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
  mainnet_ca: null,
  oracle_mode: "keeper",
  network: "devnet",
});
const mine = (n: number, deployer = CREATOR) => Array.from({ length: n }, (_, i) => ({ slab: `s${deployer}${i}`, deployer }));
const CAPS = { maxActive: 5, maxActivePerCreator: 2 };

describe("enrollment caps", () => {
  it("under both ceilings -> ok", async () => {
    const db = fakeDb({ active: mine(1) });
    expect(await checkEnrollmentCaps(db.client, { slab: "new", deployer: CREATOR, network: "devnet" }, CAPS)).toEqual({ ok: true });
  });

  it("creator at their ceiling -> 403 with the per-creator copy", async () => {
    const db = fakeDb({ active: mine(2) });
    expect(await checkEnrollmentCaps(db.client, { slab: "new", deployer: CREATOR, network: "devnet" }, CAPS)).toEqual({
      ok: false, status: 403, error: PER_CREATOR_CAP_COPY, code: "per-creator-cap",
    });
  });

  it("deployment at its ceiling (other creators) -> retryable 429 with the global copy", async () => {
    const db = fakeDb({ active: [...mine(3, "A"), ...mine(2, "B")] });
    expect(await checkEnrollmentCaps(db.client, { slab: "new", deployer: CREATOR, network: "devnet" }, CAPS)).toEqual({
      ok: false, status: 429, error: GLOBAL_CAP_COPY, code: "global-cap",
    });
  });

  it("the slab never counts against itself", async () => {
    const db = fakeDb({ active: [{ slab: "new", deployer: CREATOR }, ...mine(1)] });
    expect(await checkEnrollmentCaps(db.client, { slab: "new", deployer: CREATOR, network: "devnet" }, CAPS)).toEqual({ ok: true });
  });

  it("an unreadable count refuses (503, the retryable server copy)", async () => {
    const db = fakeDb({ countError: true });
    const v = await checkEnrollmentCaps(db.client, { slab: "new", deployer: CREATOR, network: "devnet" }, CAPS);
    expect(v).toMatchObject({ ok: false, status: 503, error: KEEPER_REGISTER_COPY.serverTrouble });
  });

  it("the cap copy reaches the creator (allow-listed); defaults and env overrides", () => {
    expect(userFacingRegistrationReason(PER_CREATOR_CAP_COPY)).toBe(PER_CREATOR_CAP_COPY);
    expect(userFacingRegistrationReason(GLOBAL_CAP_COPY)).toBe(GLOBAL_CAP_COPY);
    expect(enrollmentCapsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ maxActive: DEFAULT_MAX_ACTIVE_MARKETS, maxActivePerCreator: DEFAULT_MAX_ACTIVE_PER_CREATOR });
    expect(enrollmentCapsFromEnv({ KEEPER_MAX_ACTIVE_MARKETS: "7", KEEPER_MAX_ACTIVE_PER_CREATOR: "x" } as never)).toEqual({ maxActive: 7, maxActivePerCreator: DEFAULT_MAX_ACTIVE_PER_CREATOR });
  });
});

describe("upsertRegisteredMarketRow applies the caps on the proof path", () => {
  it("a creator at their ceiling: 403, NOTHING written", async () => {
    const db = fakeDb({ active: mine(2) });
    const r = await upsertRegisteredMarketRow(db.client, row("new"), "proof", CAPS);
    expect(r).toMatchObject({ ok: false, status: 403, error: PER_CREATOR_CAP_COPY });
    expect(db.writes).toEqual([]);
  });

  it("an indexer 'auto' row (retired) is a NEW enrollment: capped too", async () => {
    const db = fakeDb({ active: mine(2), existing: { id: "1", metadata_source: "auto", keeper_status: "retired" } });
    expect(await upsertRegisteredMarketRow(db.client, row("new"), "proof", CAPS)).toMatchObject({ ok: false, status: 403 });
    expect(db.writes).toEqual([]);
  });

  it("under the ceiling: inserted and active", async () => {
    const db = fakeDb({ active: mine(1) });
    expect(await upsertRegisteredMarketRow(db.client, row("new"), "proof", CAPS)).toEqual({ ok: true, action: "inserted", keeperActive: true });
    expect(db.writes[0]).toMatchObject({ op: "insert", payload: { keeper_status: "active" } });
  });

  it("an already-active row is not re-counted; the admin path is never capped", async () => {
    const active = { id: "1", metadata_source: "auto", keeper_status: "active" };
    const db = fakeDb({ active: mine(9), existing: active });
    expect(await upsertRegisteredMarketRow(db.client, row("new"), "proof", CAPS)).toMatchObject({ ok: true, action: "updated" });
    expect(db.countQueries).toBe(0);
    const adm = fakeDb({ active: mine(9) });
    expect(await upsertRegisteredMarketRow(adm.client, row("new"), "admin", CAPS)).toMatchObject({ ok: true, action: "inserted" });
    expect(adm.countQueries).toBe(0);
  });
});
