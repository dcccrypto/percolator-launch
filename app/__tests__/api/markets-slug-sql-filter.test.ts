/**
 * Review E5: /api/markets/SOL-PERP (slug lookup) narrows in SQL instead of reading every row on
 * the network; a slug that is not plain [A-Z0-9-] never reaches the PostgREST filter string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ calls: [] as Array<[string, ...unknown[]]>, rows: [] as unknown[] }));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    const result = () => Promise.resolve({ data: h.rows, error: null });
    const chain: Record<string, unknown> = {};
    for (const k of ["from", "select"]) chain[k] = (...a: unknown[]) => { h.calls.push([k, ...a]); return chain; };
    chain.eq = (...a: unknown[]) => {
      h.calls.push(["eq", ...a]);
      const p = result() as Promise<unknown> & Record<string, unknown>;
      p.or = (...b: unknown[]) => { h.calls.push(["or", ...b]); return result(); };
      return p;
    };
    return chain;
  },
}));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getAccountInfo: async () => null }) }));
vi.mock("@/lib/lp-portfolio", () => ({ getMarketLpCapital: async () => null }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [] }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { GET } from "@/app/api/markets/[slab]/route";

const get = (slug: string) => GET(new NextRequest(`http://x/api/markets/${encodeURIComponent(slug)}`), { params: Promise.resolve({ slab: slug }) });

describe("/api/markets/[slug] SQL narrowing", () => {
  beforeEach(() => { h.calls.length = 0; h.rows = []; });

  it("SOL-PERP: symbol (with/without -PERP) or the SOL mint, filtered in the query", async () => {
    const res = await get("SOL-PERP");
    expect(res.status).toBe(404); // no rows in the double
    expect(h.calls).toContainEqual(["or", "symbol.ilike.SOL,symbol.ilike.SOL-PERP,mint_address.eq.So11111111111111111111111111111111111111112"]);
  });

  it("a slug without a mint alias filters on the symbol only", async () => {
    await get("pengu");
    expect(h.calls).toContainEqual(["or", "symbol.ilike.PENGU,symbol.ilike.PENGU-PERP"]);
  });

  it("NEGATIVE CONTROL: a slug with filter syntax is never put in the filter string (full read instead)", async () => {
    await get("a,b.c");
    expect(h.calls.some((c) => c[0] === "or")).toBe(false);
  });
});
