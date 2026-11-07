// @vitest-environment node
/**
 * Council 2026-11-07 (Earn "Daily fee revenue $0"): with no Supabase (the v2.2 preview), GET /api/markets serves
 * rows whose volume_24h / trade_count_24h are placeholders. The route marks them stats_collected: false so Earn can
 * tell "no indexer" from "a quiet day". Real route + real SDK discovery + real Earn row mapping; only chain /
 * Supabase / Blob I/O is mocked (harness as in __tests__/lib/v22/discovery-routes.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { LAYOUT_V22, syntheticMarket } from "../lib/v22/_stamp";

const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const K22 = new PublicKey(new Uint8Array(32).fill(9));
const m22 = syntheticMarket(LAYOUT_V22, 1);
m22.set(deriveStakePool(K22, new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3"))[0].toBytes(), 16);
const info = (d: Uint8Array) => ({ data: Buffer.from(d), executable: false, lamports: 1, owner: PROG });
const io = vi.hoisted(() => ({ discoveryFails: false, network: "devnet" as "devnet" | "mainnet" }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: io.network, programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", rpcUrl: "https://api.devnet.solana.com" }),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => { throw new Error("no supabase"); } }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async () => {
      if (io.discoveryFails) throw new Error("rpc down");
      return [{ pubkey: K22, account: info(m22) }];
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.equals(K22) ? info(m22) : null)),
    getAccountInfo: async (k: PublicKey) => (k.equals(K22) ? info(m22) : null),
  }),
}));
// One curated slab, so the static devnet directory (built from this meta) is not empty when discovery fails.
vi.mock("@/lib/playground-slab-meta", () => ({
  PLAYGROUND_SLAB_META: { [new PublicKey(new Uint8Array(32).fill(9)).toBase58()]: { symbol: "NEW", name: "New", mainnet_ca: null, dex_pool_address: null } },
}));
vi.mock("@/lib/lp-portfolio", () => ({ getKnownMarketLpCapitals: async () => new Map(), scanEnabledMarketLpCapitals: async () => new Map() }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [{ slabAddress: K22.toBase58(), symbol: "NEW", label: "New" }] }));

beforeEach(() => {
  vi.resetModules();
  io.discoveryFails = false;
  io.network = "devnet";
  process.env.NEXT_PUBLIC_DEVNET_V22 = "1";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEVNET_V22;
  vi.restoreAllMocks();
});

async function rows(): Promise<{ source: string | null; markets: Record<string, unknown>[] }> {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/markets/route");
  const res = await GET(new NextRequest("http://localhost/api/markets"));
  return { source: res.headers.get("X-Percolator-Data-Source"), markets: ((await res.json()).markets ?? []) as Record<string, unknown>[] };
}

describe("no-indexer /api/markets rows are marked stats_collected: false", () => {
  it("on-chain discovery rows carry the marker, and Earn reads them as unknown volume", async () => {
    const { source, markets } = await rows();
    expect(source).toBe("on-chain-discovery");
    const row = markets.find((m) => m.slab_address === K22.toBase58());
    expect(row).toBeDefined();
    expect(row!.stats_collected).toBe(false);
    const { buildMarketVaultInfo, computeAggregates } = await import("@/hooks/useEarnStats");
    const vi0 = buildMarketVaultInfo(K22.toBase58(), "NEW", "New", null, {}, new Map([[K22.toBase58(), row!]]));
    expect(vi0.volumeKnown).toBe(false);
    expect(computeAggregates([vi0]).dailyFeeRevenue).toBeNull();
  });
  it("the static fallback rows (discovery failed) carry the marker too", async () => {
    io.discoveryFails = true;
    const { source, markets } = await rows();
    expect(source).not.toBe("on-chain-discovery");
    expect(markets.length).toBeGreaterThan(0);
    for (const m of markets) expect(m.stats_collected).toBe(false);
  });
  it("the MAINNET static fallback row carries the marker too", async () => {
    io.discoveryFails = true;
    io.network = "mainnet";
    const { markets } = await rows();
    expect(markets.length).toBeGreaterThan(0);
    for (const m of markets) expect(m.stats_collected).toBe(false);
  });
  it("the legacy (non-v17 config) discovery row carries the marker", async () => {
    const { discoveredToApiRow } = await import("@/lib/discovered-market-rows");
    const row = discoveredToApiRow({ slabAddress: K22, programId: PROG, config: { collateralMint: K22 }, params: { initialMarginBps: 1000n } } as never);
    expect(row.max_leverage).toBeDefined(); // the legacy branch, not the v17 one
    expect(row.stats_collected).toBe(false);
  });
});
