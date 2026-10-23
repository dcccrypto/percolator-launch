// @vitest-environment node
/**
 * GET /api/markets/health — read-only health for market cards / trade page,
 * plus the security-review hardening (canonical cache key, per-IP limit,
 * generic 502 body).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { MARKET_HEALTH_SLICE_LEN } from "@/lib/market-health";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { v22LapsedMarket, v22MarketBytes } from "../helpers/v22-fixtures";

const WRAPPER = DEVNET_PROGRAM_IDS.wrapper;
const MURPHY = "7h3wNxjzPo6pTfWQ7uiTjDSsprGEeMNh696efmYrpAX2";
const PENGU = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";
const fixture = (n: string) => Buffer.from(readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", `${n}.b64`), "utf8").trim(), "base64");

const m = vi.hoisted(() => ({ getMultipleAccountsInfoAndContext: vi.fn(), ipCounter: 0 }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getMultipleAccountsInfoAndContext: m.getMultipleAccountsInfoAndContext }) }));
vi.mock("@/lib/lp-portfolio", () => ({
  getKnownMarketLpCapitals: async () => new Map([["ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ", 49_000_000_000n]]),
  // Sub-floor, not zero (STONK-shaped): depleted all the same.
  scanEnabledMarketLpCapitals: async () => new Map([["7h3wNxjzPo6pTfWQ7uiTjDSsprGEeMNh696efmYrpAX2", 841_748n]]),
}));
vi.mock("@/lib/get-client-ip", () => ({ getClientIp: () => `10.0.0.${m.ipCounter}` }));

import { GET } from "../../app/api/markets/health/route";

const req = (qs: string) => new NextRequest(`http://localhost/api/markets/health?${qs}`);
// The route asks for the first MARKET_HEALTH_SLICE_LEN bytes (header + asset slot 0): 3,675 flag off, 4,059 flag on (one v2.2 slot).
const acct = (data: Buffer, owner = WRAPPER) => ({ data: data.subarray(0, MARKET_HEALTH_SLICE_LEN), owner: new PublicKey(owner), lamports: 1, executable: false });
// Market bytes of the ACTIVE mode: the live v18 captures flag off; flag on, the captured v2.2 market (healthy) and the same market with its backing
// buckets lapsed (the self-heal "repairable" state Murphy showed on v18).
const market = (name: "murphy-market-v18-lapsed" | "pengu-market-v18-healthy"): Buffer =>
  isDevnetV22Enabled() ? Buffer.from(name === "murphy-market-v18-lapsed" ? v22LapsedMarket() : v22MarketBytes()) : fixture(name);

describe("/api/markets/health", () => {
  beforeEach(() => {
    m.ipCounter++;
    m.getMultipleAccountsInfoAndContext.mockReset();
  });

  it("decodes each market: Murphy LP depleted + repairable, PENGU funded", async () => {
    const sorted = [MURPHY, PENGU].sort();
    m.getMultipleAccountsInfoAndContext.mockResolvedValue({
      context: { slot: 505580400 },
      value: sorted.map((s) => acct(market(s === MURPHY ? "murphy-market-v18-lapsed" : "pengu-market-v18-healthy"))),
    });
    const res = await GET(req(`slabs=${sorted.join(",")}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.markets[MURPHY].lpDepleted).toBe(true);
    expect(body.markets[MURPHY].lpCapital).toBe("841748");
    expect(body.markets[MURPHY].lockReasons).toContain("repairable");
    expect(body.markets[MURPHY].badges[0].id).toBe("lp-depleted");
    expect(body.markets[PENGU].lpDepleted).toBe(false);
    expect(body.markets[PENGU].lockReasons).not.toContain("repairable"); // control: only the lapsed market is repairable
    // dataSlice requested, not the full account
    expect(m.getMultipleAccountsInfoAndContext.mock.calls[0][1]).toMatchObject({ dataSlice: { offset: 0, length: MARKET_HEALTH_SLICE_LEN } });
  });

  it("NEGATIVE CONTROL: an account not owned by the wrapper is null, never decoded", async () => {
    m.getMultipleAccountsInfoAndContext.mockResolvedValue({
      context: { slot: 1 },
      value: [acct(market("murphy-market-v18-lapsed"), "11111111111111111111111111111111")],
    });
    const res = await GET(req(`slabs=${MURPHY}`));
    expect((await res.json()).markets[MURPHY]).toBeNull();
  });

  it("400 on bad input", async () => {
    expect((await GET(req("slabs=nope"))).status).toBe(400);
    expect((await GET(req(""))).status).toBe(400);
  });

  it("LOW-1: a non-canonical slab list redirects to the sorted one (one cache key per set), no RPC", async () => {
    const res = await GET(req(`slabs=${PENGU},${MURPHY},${PENGU}`));
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get("location")!).searchParams.get("slabs")).toBe([MURPHY, PENGU].sort().join(","));
    expect(m.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
  });

  it("LOW-1: per-IP rate limit", async () => {
    m.getMultipleAccountsInfoAndContext.mockRejectedValue(new Error("x"));
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await GET(req("slabs=bad"))).status;
    expect(last).toBe(429);
  });

  it("LOW-2: upstream failure → generic 502, the RPC error text is not echoed", async () => {
    m.getMultipleAccountsInfoAndContext.mockRejectedValue(new Error("401 https://secret-endpoint.example/?api-key=abc"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(req(`slabs=${PENGU}`));
    expect(res.status).toBe(502);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/secret-endpoint|api-key/);
  });
});
