// @vitest-environment node
/**
 * GET /api/markets on the on-chain-discovery path (no Supabase): on v2.2 a registered market whose mainnet_ca is a dollar
 * stablecoin (owner 2026-11-09) is not listed; the same row is listed off v2.2. Real route, real filter; only I/O mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
// vi.resetModules() gives the route a fresh flag module, so the flag is driven through the environment it reads.
const setV22 = (on: boolean | null) => { if (on === null) delete process.env.NEXT_PUBLIC_V22; else process.env.NEXT_PUBLIC_V22 = on ? "1" : "0"; };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STAKE_POOL_PDA = new PublicKey("So11111111111111111111111111111111111111112");
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const CTRL_SLAB = new PublicKey(new Uint8Array(32).fill(7));
const USDC_SLAB = new PublicKey(new Uint8Array(32).fill(9));

const mocks = vi.hoisted(() => ({ discovered: [] as unknown[] }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", rpcUrl: "https://api.devnet.solana.com" }),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => { throw new Error("no supabase"); } }));
vi.mock("@/lib/server-rpc", () => ({ getServerConnection: () => ({ getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) }) }));
vi.mock("@/lib/lp-portfolio", () => ({ getKnownMarketLpCapitals: async () => new Map(), scanEnabledMarketLpCapitals: async () => new Map() }));
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => [
    { slabAddress: CTRL_SLAB.toBase58(), symbol: "CTRL", label: "Ctrl", mainnetCA: "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU" },
    { slabAddress: USDC_SLAB.toBase58(), symbol: "USDC", label: "Usdc", mainnetCA: USDC },
  ],
}));
vi.mock("@/lib/v22/discovery", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/discovery")>()), discoverMarkets: async () => mocks.discovered }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  return { ...actual, discoverMarkets: async () => mocks.discovered, deriveStakePool: () => [STAKE_POOL_PDA], isV17Account: () => false };
});

const market = (slab: PublicKey) => ({
  slabAddress: slab, programId: PROG,
  configV17: { collateralMint: MINT, marketauth: STAKE_POOL_PDA, oracleMode: 3, markEwmaE6: 100_000_000n, tradeFeeBps: 10n },
});

async function listSlabs() {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/markets/route");
  const res = await GET(new NextRequest("http://localhost/api/markets"));
  expect(res.headers.get("X-Percolator-Data-Source")).toBe("on-chain-discovery");
  return ((await res.json()).markets as { slab_address: string }[]).map((m) => m.slab_address);
}

describe("GET /api/markets discovery path: stablecoin underlyings", () => {
  beforeEach(() => { vi.resetModules(); mocks.discovered = [market(CTRL_SLAB), market(USDC_SLAB)]; });
  afterEach(() => setV22(null));

  it("v2.2 on: the USDC-underlying market is not listed; the control is", async () => {
    setV22(true);
    const slabs = await listSlabs();
    expect(slabs).toContain(CTRL_SLAB.toBase58());
    expect(slabs).not.toContain(USDC_SLAB.toBase58());
  });

  it("v2.2 off: unchanged, both are listed", async () => {
    setV22(false);
    const slabs = await listSlabs();
    expect(slabs).toContain(CTRL_SLAB.toBase58());
    expect(slabs).toContain(USDC_SLAB.toBase58());
  });
});
