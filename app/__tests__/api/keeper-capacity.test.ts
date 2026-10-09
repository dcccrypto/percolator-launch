// @vitest-environment node
/**
 * #3320: GET /api/playground/keeper-capacity answers ONLY `{ atLimit }`, ONLY for a wallet linked to
 * the caller's verified Privy session. Client shape from @0x-SquidSol's #3325, which answered any
 * wallet with its markets and was refused for that reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkEnrollmentCaps, PER_CREATOR_CAP_COPY, readCreatorAtLimit } from "@/lib/keeper-enrollment-guard";

type Row = { slab_address: string; deployer: string; network: string; keeper_status: string };

/** Minimal PostgREST-shaped builder over an array: eq / neq, count+head. Records every query. */
const queries: { eq: [string, string][] }[] = [];
function fakeSupabase(rows: Row[], opts: { fail?: boolean } = {}) {
  return {
    from: () => ({
      select: () => {
        const filters: ((r: Row) => boolean)[] = [];
        const q: { eq: [string, string][] } = { eq: [] };
        queries.push(q);
        const b = {
          eq: (k: keyof Row, v: string) => (filters.push((r) => r[k] === v), q.eq.push([k, v]), b),
          neq: (k: keyof Row, v: string) => (filters.push((r) => r[k] !== v), b),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(
              opts.fail
                ? { count: null, error: { message: "boom-secret-detail" } }
                : { count: rows.filter((r) => filters.every((f) => f(r))).length, error: null },
            ).then(res),
        };
        return b;
      },
    }),
  } as never;
}

const W = "7Q3CVASeMNyYX4Q5zc7xCNhiCPZeSoMNLnYACUBR5qeQ";
const OTHER = "4bXx1ioqZ5XLC86DCwuCtu8mPfS9MT9EEY12SxH1FEGa";
const rows = (n: number, over: Partial<Row> = {}): Row[] =>
  Array.from({ length: n }, (_, i) => ({ slab_address: `S${i}`, deployer: W, network: "devnet", keeper_status: "active", ...over }));
const caps = { maxActive: 90, maxActivePerCreator: 10 };

describe("readCreatorAtLimit (shares checkEnrollmentCaps' filter)", () => {
  it("counts only this wallet's ACTIVE rows on this network", async () => {
    const table = [
      ...rows(9),
      ...rows(5, { keeper_status: "retired", slab_address: "R" }),
      ...rows(5, { network: "mainnet", slab_address: "M" }),
      ...rows(20, { deployer: OTHER, slab_address: "O" }),
    ];
    expect(await readCreatorAtLimit(fakeSupabase(table), { deployer: W, network: "devnet" }, caps)).toEqual({ ok: true, atLimit: false });
    expect(await readCreatorAtLimit(fakeSupabase([...table, ...rows(1, { slab_address: "X" })]), { deployer: W, network: "devnet" }, caps)).toEqual({ ok: true, atLimit: true });
  });

  it("a failed read is unknown, never a verdict", async () => {
    expect(await readCreatorAtLimit(fakeSupabase(rows(10), { fail: true }), { deployer: W, network: "devnet" }, caps)).toEqual({ ok: false });
  });

  it("PARITY: for a new slab, atLimit iff keeper-register's guard refuses it per-creator; the global cap is not the per-wallet limit", async () => {
    for (let n = 0; n <= 12; n++) {
      const sb = fakeSupabase(rows(n));
      const read = await readCreatorAtLimit(sb, { deployer: W, network: "devnet" }, caps);
      const guard = await checkEnrollmentCaps(sb, { slab: "NEW", deployer: W, network: "devnet" }, caps);
      expect(read.ok && read.atLimit).toBe(!guard.ok && guard.code === "per-creator-cap");
    }
    // Deployment full, this wallet nearly empty: the guard says global-cap, the read says NOT at the wallet's limit.
    const full = fakeSupabase([...rows(2), ...rows(95, { deployer: OTHER, slab_address: "O" })]);
    const guard = await checkEnrollmentCaps(full, { slab: "NEW", deployer: W, network: "devnet" }, caps);
    expect(!guard.ok && guard.code).toBe("global-cap");
    expect(await readCreatorAtLimit(full, { deployer: W, network: "devnet" }, caps)).toEqual({ ok: true, atLimit: false });
    expect(PER_CREATOR_CAP_COPY).toBeTruthy();
  });
});

const h = vi.hoisted(() => ({
  supabase: null as unknown,
  throwClient: false,
  allowed: true,
  auth: { ok: false, status: 401, reason: "missing-token" } as unknown,
}));
vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => {
    if (h.throwClient) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
    return h.supabase;
  },
  getServerNetwork: () => "devnet",
}));
vi.mock("@/lib/keeper-capacity-rate-limit", () => ({
  checkKeeperCapacityRateLimit: async () => ({ allowed: h.allowed, retryAfter: 7 }),
}));
vi.mock("@/lib/privy-auth", () => ({ verifyPrivyAuth: async () => h.auth }));

import { GET } from "@/app/api/playground/keeper-capacity/route";

const req = (wallet: string) => new NextRequest(`http://localhost/api/playground/keeper-capacity?wallet=${wallet}`);
const session = (wallets: string[]) => ({ ok: true, userId: "did:privy:x", email: null, emails: [], solanaWallets: wallets });

describe("GET /api/playground/keeper-capacity", () => {
  beforeEach(() => {
    // The table holds the caller at the limit AND another creator at the limit.
    h.supabase = fakeSupabase([...rows(10), ...rows(10, { deployer: OTHER, slab_address: "O" })]);
    h.throwClient = false;
    h.allowed = true;
    h.auth = session([W]);
    queries.length = 0;
  });

  it("the caller's own wallet: exactly { atLimit }, uncached", async () => {
    const res = await GET(req(W));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ atLimit: true });
    expect(queries.every((q) => q.eq.some(([k, v]) => k === "deployer" && v === W))).toBe(true);
  });

  it("below the limit says false, and carries no count or list", async () => {
    h.supabase = fakeSupabase(rows(3));
    const body = await (await GET(req(W))).json();
    expect(body).toEqual({ atLimit: false });
    expect(Object.keys(body)).toEqual(["atLimit"]);
  });

  it("NEGATIVE CONTROL: another creator's wallet is refused and the database is never queried for it", async () => {
    const res = await GET(req(OTHER)); // OTHER really is at the limit in the table
    expect(res.status).toBe(403);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("atLimit");
    expect(queries).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: a caller with several linked wallets is answered for each of them, and for no one else", async () => {
    h.auth = session([W, OTHER]);
    expect((await GET(req(OTHER))).status).toBe(200);
    expect((await GET(req("11111111111111111111111111111111"))).status).toBe(403);
  });

  it("unauthenticated: refused 401, nothing queried; an unconfigured Privy is 503, nothing queried", async () => {
    h.auth = { ok: false, status: 401, reason: "missing-token" };
    expect((await GET(req(W))).status).toBe(401);
    h.auth = { ok: false, status: 401, reason: "invalid-token" };
    expect((await GET(req(W))).status).toBe(401);
    h.auth = { ok: false, status: 503, reason: "not-configured" };
    expect((await GET(req(W))).status).toBe(503);
    expect(queries).toHaveLength(0);
  });

  it("a session with no linked wallet in its identity token cannot read any wallet", async () => {
    h.auth = session([]);
    expect((await GET(req(W))).status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it("an invalid wallet is 400", async () => {
    expect((await GET(req("not-a-key"))).status).toBe(400);
  });

  it("a failed count or an unconfigured database is 503 and never echoes the reason", async () => {
    h.supabase = fakeSupabase([], { fail: true });
    const a = await GET(req(W));
    expect(a.status).toBe(503);
    expect(JSON.stringify(await a.json())).not.toContain("boom");
    h.throwClient = true;
    const b = await GET(req(W));
    expect(b.status).toBe(503);
    expect(JSON.stringify(await b.json())).not.toContain("SUPABASE");
  });

  it("rate limited is 429 with Retry-After, before any auth or query", async () => {
    h.allowed = false;
    const res = await GET(req(W));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(queries).toHaveLength(0);
  });
});
