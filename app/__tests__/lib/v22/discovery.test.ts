/**
 * Version-aware discovery (lib/v22/discovery.ts over the vendored SDK sdk#406 @ adf8fd0 discovery.ts).
 * The installed 8.0.0 discoverMarkets / getMarketsByAddress accept wrapper VERSION 18 only, so a v2.2 (VERSION 19)
 * market was invisible to every list, route and page. Flag ON finds 18 and 19 and skips an unknown VERSION and any
 * non-market account; flag OFF is the installed behaviour (VERSION 18 only), which is the negative control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import * as installed from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { discoverMarkets, getMarketsByAddress } from "@/lib/v22/discovery";
import { isClosedMarketTombstone } from "@/lib/closed-market-tombstone";
import { LAYOUT_V21, LAYOUT_V22, stampHeader, syntheticMarket, syntheticPortfolio } from "./_stamp";

const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const K21 = key(1), K22 = key(2), KPF = key(3), K20 = key(4);

const accounts = new Map<string, Uint8Array>([
  [K21.toBase58(), syntheticMarket(LAYOUT_V21, 1)],
  [K22.toBase58(), syntheticMarket(LAYOUT_V22, 1)],
  [KPF.toBase58(), syntheticPortfolio(LAYOUT_V22)],
  [K20.toBase58(), syntheticMarket(LAYOUT_V22, 1, { version: 20 })],
]);

function connection() {
  const info = (data: Uint8Array) => ({ data: Buffer.from(data), executable: false, lamports: 1, owner: PROG });
  return {
    getProgramAccounts: vi.fn(async () => [...accounts].map(([k, d]) => ({ pubkey: new PublicKey(k), account: info(d) }))),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => (accounts.has(k.toBase58()) ? info(accounts.get(k.toBase58())!) : null))),
  } as never;
}
const slabs = (m: { slabAddress: PublicKey }[]) => m.map((x) => x.slabAddress.toBase58()).sort();

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.restoreAllMocks();
});

describe("flag on: VERSION 18 and 19 are found", () => {
  beforeEach(() => __setDevnetV22ForTest(true));
  it("discoverMarkets finds the v2.1 and the v2.2 market, skips the portfolio and the unknown VERSION 20 (loudly)", async () => {
    const found = await discoverMarkets(connection(), PROG, { sequential: true, maxTierQueries: 0 });
    expect(slabs(found)).toEqual([K21.toBase58(), K22.toBase58()].sort());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("VERSION 20"));
    expect((found.find((m) => m.slabAddress.equals(K22)) as { wrapperVersion?: number }).wrapperVersion).toBe(19);
  });
  it("getMarketsByAddress finds both too", async () => {
    const found = await getMarketsByAddress(connection(), PROG, [K21, K22, K20]);
    expect(slabs(found)).toEqual([K21.toBase58(), K22.toBase58()].sort());
  });
});

describe("flag off: unchanged (the installed behaviour, VERSION 18 only)", () => {
  it("discoverMarkets does not find the v2.2 market", async () => {
    const found = await discoverMarkets(connection(), PROG, { sequential: true, maxTierQueries: 0 });
    expect(slabs(found)).toEqual([K21.toBase58()]);
  });
  it("getMarketsByAddress does not find the v2.2 market", async () => {
    expect(slabs(await getMarketsByAddress(connection(), PROG, [K21, K22]))).toEqual([K21.toBase58()]);
  });
  it("is the installed function's result, call for call", async () => {
    const a = await discoverMarkets(connection(), PROG, { sequential: true, maxTierQueries: 0 });
    const b = await installed.discoverMarkets(connection(), PROG, { sequential: true, maxTierQueries: 0 });
    expect(slabs(a)).toEqual(slabs(b));
  });
});

describe("closed-market tombstone stamps the VERSION of the program", () => {
  const tomb = (v: number) => stampHeader(new Uint8Array(16), 8, v);
  it("VERSION 19 counts as a tombstone only with the flag on; 18 always", () => {
    expect(isClosedMarketTombstone(tomb(18))).toBe(true);
    expect(isClosedMarketTombstone(tomb(19))).toBe(false);
    __setDevnetV22ForTest(true);
    expect(isClosedMarketTombstone(tomb(19))).toBe(true);
    expect(isClosedMarketTombstone(tomb(20))).toBe(false);
  });
});

describe("source guard: no consumer calls the installed discovery directly", () => {
  it("routes and the directory use lib/v22/discovery", async () => {
    const fs = await import("node:fs");
    for (const f of ["lib/market-directory-discovery.ts", "app/api/markets/route.ts", "app/api/stats/route.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).toMatch(/@\/lib\/v22\/discovery/);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\b(discoverMarkets|getMarketsByAddress)\b[^}]*\}\s*from\s*"@percolatorct\/sdk"/);
    }
  });
});
