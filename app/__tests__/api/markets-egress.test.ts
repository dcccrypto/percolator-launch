/**
 * Review E2 (2026-10-14): /api/markets on the Supabase path answers ?program_id= without a read,
 * shares the edge cache policy with /api/stats, and keeps ?fresh= out of the CDN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ loadMergedMarketRows: vi.fn(), WRAPPER: "11111111111111111111111111111112" }));
const WRAPPER = mocks.WRAPPER;

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: mocks.loadMergedMarketRows, MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/config", () => ({
  getConfig: vi.fn(() => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com", programId: mocks.WRAPPER })),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: vi.fn(() => ({})) }));

import { GET } from "@/app/api/markets/route";

const ROW = { slab_address: "AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr", symbol: "SOL", decimals: 9, last_price: 117, volume_24h: 1, vault_balance: 51529591886, c_tot: 1, total_accounts: 3, is_complete: true, oracle_mode: "admin" };
const req = (q = "") => new NextRequest(`http://localhost/api/markets${q}`);

describe("GET /api/markets egress", () => {
  beforeEach(() => {
    mocks.loadMergedMarketRows.mockReset();
    mocks.loadMergedMarketRows.mockResolvedValue([{ ...ROW }]);
  });

  it("another program's id is an empty list, answered without reading the registry", async () => {
    const res = await GET(req("?program_id=g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in"));
    expect(res.status).toBe(200);
    expect((await res.json()).markets).toEqual([]);
    expect(mocks.loadMergedMarketRows).not.toHaveBeenCalled();
  });

  it("NEGATIVE CONTROL: the configured program's id lists the rows", async () => {
    const res = await GET(req(`?program_id=${WRAPPER}`));
    expect((await res.json()).markets.map((m: { slab_address: string }) => m.slab_address)).toEqual([ROW.slab_address]);
  });

  it("caches at the edge for 15 s + 60 s stale, from the shared copy", async () => {
    const res = await GET(req("?include_zombie=true&limit=500"));
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=15, stale-while-revalidate=60");
    expect(mocks.loadMergedMarketRows).toHaveBeenCalledWith({});
  });

  it("?fresh= asks for a <= 3 s copy and is never stored by the CDN", async () => {
    const res = await GET(req("?include_zombie=true&limit=500&fresh=123"));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.loadMergedMarketRows).toHaveBeenCalledWith({ maxAgeMs: 3_000 });
  });
});
