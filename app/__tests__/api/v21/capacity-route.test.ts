// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getServiceClient = vi.fn();
vi.mock("@/lib/supabase", () => ({ getServiceClient: () => getServiceClient() }));

import { GET } from "@/app/api/v21/capacity/route";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const SLAB = "11111111111111111111111111111111";
const req = (qs = "") => new NextRequest(`http://localhost/api/v21/capacity${qs}`);

/** A chainable fake of the supabase builder; records the calls. */
function fakeClient(tables: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  return {
    calls,
    client: {
      from(table: string) {
        const rec = { table, ops: [] as Array<[string, unknown[]]> };
        calls.push(rec);
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "gte", "order", "limit"]) b[m] = (...a: unknown[]) => (rec.ops.push([m, a]), b);
        b.then = (res: (v: unknown) => unknown) => res(tables[table] ?? { data: [], error: null });
        return b;
      },
    },
  };
}

beforeEach(() => {
  getServiceClient.mockReset();
  __setDevnetV21ForTest(true);
});
afterEach(() => __setDevnetV21ForTest(null));

describe("GET /api/v21/capacity", () => {
  it("flag off: 404 and no database access at all", async () => {
    __setDevnetV21ForTest(false);
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it("rejects a malformed slab and hours with 400 before touching the database", async () => {
    expect((await GET(req("?slab=%27%3Bdrop"))).status).toBe(400);
    expect((await GET(req("?hours=99999"))).status).toBe(400);
    expect(getServiceClient).not.toHaveBeenCalled();
  });

  it("503 when the service client is not configured", async () => {
    getServiceClient.mockImplementation(() => {
      throw new Error("Supabase env vars not set");
    });
    expect((await GET(req())).status).toBe(503);
  });

  it("latest per market with symbols; filters to a recent window", async () => {
    const f = fakeClient({
      market_capacity_snapshots: {
        error: null,
        data: [
          { slab: SLAB, ts: "2026-10-05T12:10:00Z", capacity_notional_atoms: "9000000", lp_equity_atoms: "3000000" },
          { slab: SLAB, ts: "2026-10-05T12:00:00Z", capacity_notional_atoms: "1000000", lp_equity_atoms: "1000000" },
        ],
      },
      markets: { error: null, data: [{ slab_address: SLAB, symbol: "SOL" }, { slab_address: "other", symbol: "X" }] },
    });
    getServiceClient.mockReturnValue(f.client);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markets: Array<{ slab: string; symbol: string | null; capacityUsd: number }> };
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0]).toMatchObject({ slab: SLAB, symbol: "SOL", capacityUsd: 9 });
    const snapOps = f.calls.find((c) => c.table === "market_capacity_snapshots")!.ops.map((o) => o[0]);
    expect(snapOps).toContain("gte");
  });

  it("one market's series: ascending, bounded to MAX_POINTS", async () => {
    const data = Array.from({ length: 1_200 }, (_, i) => ({ slab: SLAB, ts: new Date(Date.UTC(2026, 9, 5, 0, 0, i * 10)).toISOString(), lp_equity_atoms: String(i * 1_000_000) }));
    const f = fakeClient({ market_capacity_snapshots: { error: null, data } });
    getServiceClient.mockReturnValue(f.client);
    const res = await GET(req(`?slab=${SLAB}&hours=6`));
    const body = (await res.json()) as { points: Array<{ t: number }> };
    expect(body.points.length).toBe(400);
    expect(body.points[0].t).toBeLessThan(body.points[399].t);
    const ops = f.calls[0].ops;
    expect(ops.find((o) => o[0] === "eq")![1]).toEqual(["slab", SLAB]);
  });

  it("a database error is a clean 502 with no detail", async () => {
    getServiceClient.mockReturnValue(fakeClient({ market_capacity_snapshots: { data: null, error: { message: "relation does not exist: secret detail" } } }).client);
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
