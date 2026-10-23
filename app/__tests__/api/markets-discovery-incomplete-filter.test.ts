/**
 * GET /api/markets on the on-chain-discovery path (no Supabase, devnet
 * playground) must hide markets whose creation never finished (#2641), WITHOUT
 * hiding: the curated seeds, complete user markets, or rows with no
 * completeness signal. Behavioural (drives the real route + real
 * isMarketauthComplete); only chain/Blob/Supabase I/O is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

const STAKE_POOL_PDA = new PublicKey("So11111111111111111111111111111111111111112");
const CREATOR = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
// A real curated seed (PLAYGROUND_SLAB_META): SOL-PERP.
const CURATED_SLAB = new PublicKey("AzagguvrWmRgcBpsKuqomW7Yb1YUUd6UzcrkiRsqdhr");
const USER_COMPLETE = new PublicKey(new Uint8Array(32).fill(7));
const USER_INCOMPLETE = new PublicKey(new Uint8Array(32).fill(9));

const mocks = vi.hoisted(() => ({ discovered: [] as unknown[] }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    network: "devnet",
    programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
    vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3",
    rpcUrl: "https://api.devnet.solana.com",
  }),
}));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => {
    throw new Error("no supabase");
  },
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) }),
}));
vi.mock("@/lib/lp-portfolio", () => ({
  getKnownMarketLpCapitals: async () => new Map(),
  scanEnabledMarketLpCapitals: async () => new Map(),
}));
vi.mock("@/lib/playground-registered-markets", () => ({
  // Both user markets are registered (as wizard-launched ones are), so the
  // ONLY thing that can hide USER_INCOMPLETE is the completeness filter.
  readRegisteredMarkets: async () => [
    { slabAddress: USER_COMPLETE.toBase58(), symbol: "DONE", label: "Done" },
    { slabAddress: USER_INCOMPLETE.toBase58(), symbol: "HALF", label: "Half" },
  ],
}));
// The route discovers through lib/v22/discovery (flag off it is the installed SDK function, flag on the VERSION-aware port): stub THAT seam so the
// fixtures mean the same thing in every mode.
vi.mock("@/lib/v22/discovery", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/discovery")>()),
  discoverMarkets: async () => mocks.discovered,
}));
vi.mock("@percolatorct/sdk", async (orig) => {
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  return {
    ...actual,
    discoverMarkets: async () => mocks.discovered,
    // Completeness is decided by marketauth == this PDA (real helper runs).
    deriveStakePool: () => [STAKE_POOL_PDA],
    isV17Account: () => false,
  };
});

function market(slab: PublicKey, marketauth: PublicKey) {
  return {
    slabAddress: slab,
    programId: PROG,
    configV17: {
      collateralMint: MINT,
      marketauth,
      oracleMode: 3,
      markEwmaE6: 100_000_000n,
      tradeFeeBps: 10n,
    },
  };
}

async function listSlabs() {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/markets/route");
  const res = await GET(new NextRequest("http://localhost/api/markets"));
  expect(res.headers.get("X-Percolator-Data-Source")).toBe("on-chain-discovery");
  const body = await res.json();
  return (body.markets as { slab_address: string }[]).map((m) => m.slab_address);
}

describe("GET /api/markets on-chain discovery: completeness filter (#2641)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("hides a registered market whose marketauth never rotated to the stake pool; keeps complete ones", async () => {
    mocks.discovered = [
      market(USER_COMPLETE, STAKE_POOL_PDA),
      market(USER_INCOMPLETE, CREATOR),
      // Relaunch (2026-10-01): PLAYGROUND_SLAB_META is empty, so a former curated seed gets no
      // exemption any more — not rotated means hidden, like any other market.
      market(CURATED_SLAB, CREATOR),
    ];
    const slabs = await listSlabs();
    expect(slabs).toContain(USER_COMPLETE.toBase58());
    expect(slabs).not.toContain(CURATED_SLAB.toBase58());
    expect(slabs).not.toContain(USER_INCOMPLETE.toBase58());
  });
});
