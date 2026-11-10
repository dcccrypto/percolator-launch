// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  registered: vi.fn(),
  pairs: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/registered-pool", () => ({
  registeredPoolForMint: h.registered,
}));

vi.mock("@/lib/jupiter-price", () => ({
  fetchJupiterUsdPrice: async () => 7.5,
}));

vi.mock("@/lib/dex-pool-owner", () => ({
  MAX_CLASSIFY_POOLS: 20,
  classifyPoolsByOwner: async (addresses: string[]) =>
    Object.fromEntries(
      addresses.map(a => [a, "meteora-dlmm"])
    ),
  isOfferable: (type: string) => type === "meteora-dlmm",
}));

const MINT =
  "9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj";

const REGISTERED =
  "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi";

const OTHER =
  "7Nj7mBE7oGPRWCEoUzfbNVPgq12w3V5egHkfd4nvGkr6";

function pair(address: string, price: number) {
  return {
    chainId: "solana",
    dexId: "meteora",
    pairAddress: address,
    priceUsd: String(price),
    liquidity: { usd: 100000 },
    baseToken: { symbol: "TEST", address: MINT },
  };
}

describe("V22 corrected resolver TTL", () => {
  it("expires cached unregistered price after 300 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const start = Date.parse("2026-11-09T00:00:00Z");
      vi.setSystemTime(start);

      // Important: load the resolver AFTER installing fake Date.
      vi.resetModules();

      const { GET } = await import(
        "@/app/api/oracle/resolve/[ca]/route"
      );

      h.registered.mockReset().mockResolvedValue(null);
      h.pairs = [pair(OTHER, 9)];

      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({
          pairs: h.pairs,
        }), { status: 200 })
      ));

      const resolve = async () => {
        const response = await GET(
          new NextRequest(
            `http://localhost/api/oracle/resolve/${MINT}`
          ),
          { params: Promise.resolve({ ca: MINT }) },
        );

        return {
          status: response.status,
          body: await response.json() as {
            cached?: boolean;
            price?: number;
            dexPoolAddress?: string;
          },
        };
      };

      // Initial: no registered market.
      const first = await resolve();

      expect(first.status).toBe(200);
      expect(first.body.cached).toBe(false);
      expect(first.body.dexPoolAddress).toBe(OTHER);

      // Market registration becomes visible.
      h.registered.mockResolvedValue({
        slabAddress: MINT,
        pool: REGISTERED,
        dexType: "meteora-dlmm",
      });

      h.pairs = [
        pair(OTHER, 9),
        pair(REGISTERED, 4.5),
      ];


      // New registered identity invalidates the old cache key.
      vi.setSystemTime(start + 60_001);

      const after60 = await resolve();

      expect(after60.status).toBe(200);
      expect(after60.body.cached).toBe(false);
      expect(after60.body.dexPoolAddress).toBe(REGISTERED);
      expect(after60.body.price).toBe(4.5);

      console.log("CACHE_IDENTITY_SWITCH=PASS");

      // Only 240 seconds have elapsed since the new entry.
      vi.setSystemTime(start + 300_001);

      const after300 = await resolve();

      expect(after300.status).toBe(200);
      expect(after300.body.cached).toBe(true);
      expect(after300.body.dexPoolAddress).toBe(REGISTERED);
      expect(after300.body.price).toBe(4.5);

      console.log("REGISTERED_CACHE_REUSE=PASS");

      // More than 300 seconds after the registered entry.
      vi.setSystemTime(start + 360_002);

      const after360 = await resolve();

      expect(after360.status).toBe(200);
      expect(after360.body.cached).toBe(false);
      expect(after360.body.dexPoolAddress).toBe(REGISTERED);
      expect(after360.body.price).toBe(4.5);

      console.log("REGISTERED_CACHE_EXPIRY=PASS");
      console.log("TTL_UPDATED_DIAGNOSTIC=PASS");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
