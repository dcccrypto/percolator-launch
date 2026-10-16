// @vitest-environment node
/**
 * GET /api/markets (on-chain discovery, v2.2 flag on) reads max_portfolio_assets from the real slab bytes and emits
 * it per row (the listing surfaces hide > 1), and carries the env list's withdraw_only. Real devnet account bytes
 * (captured 2026-10-14); only chain/Blob/Supabase I/O is mocked. The multi-asset row stays in the payload (direct
 * links, portfolio symbol resolution); hiding it is the listing predicates' job (market-list.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PROG = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const SINGLE = new PublicKey("BYFuWyuoUGhP1n8wpD8gXH2ciDsegyF1UJCQvBiVx7T5");
const MULTI = new PublicKey("2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw");
const STAKE_POOL_PDA = new PublicKey("So11111111111111111111111111111111111111112");
const bytes = (n: string): Uint8Array => new Uint8Array(Buffer.from((JSON.parse(readFileSync(join(__dirname, "..", "fixtures", n), "utf-8")) as { dataBase64: string }).dataBase64, "base64"));
const data = new Map<string, Uint8Array>([
  [SINGLE.toBase58(), bytes("v22-market-single-asset-SOL.json")],
  [MULTI.toBase58(), bytes("v22-market-multi-asset-2xhs.json")],
]);

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", programId: "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", rpcUrl: "https://api.devnet.solana.com" }),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => { throw new Error("no supabase"); } }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (data.has(k.toBase58()) ? { data: Buffer.from(data.get(k.toBase58())!) } : null)),
  }),
}));
vi.mock("@/lib/lp-portfolio", () => ({ getKnownMarketLpCapitals: async () => new Map(), scanEnabledMarketLpCapitals: async () => new Map() }));
vi.mock("@/lib/playground-registered-markets", () => ({
  readRegisteredMarkets: async () => [
    { slabAddress: SINGLE.toBase58(), symbol: "SOL", label: "Solana" },
    { slabAddress: MULTI.toBase58(), symbol: "MULTI", label: "Multi" },
  ],
}));
vi.mock("@percolatorct/sdk", async (orig) => {
  const actual = await orig<typeof import("@percolatorct/sdk")>();
  return { ...actual, deriveStakePool: () => [STAKE_POOL_PDA], isV17Account: () => false };
});
vi.mock("@/lib/v22/discovery", () => ({
  discoverMarkets: async () => [SINGLE, MULTI].map((slab) => ({ slabAddress: slab, programId: PROG, configV17: { collateralMint: MINT, marketauth: STAKE_POOL_PDA, oracleMode: 3, markEwmaE6: 100_000_000n, tradeFeeBps: 10n } })),
}));

async function rows(): Promise<Record<string, Record<string, unknown>>> {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/markets/route");
  const res = await GET(new NextRequest("http://localhost/api/markets"));
  expect(res.headers.get("X-Percolator-Data-Source")).toBe("on-chain-discovery");
  const body = (await res.json()) as { markets: Record<string, unknown>[] };
  return Object.fromEntries(body.markets.map((m) => [m.slab_address as string, m]));
}

describe("GET /api/markets: max_portfolio_assets / withdraw_only (v2.2)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_DEVNET_V22", "1");
    vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("emits the on-chain max_portfolio_assets per row; the multi-asset row stays in the payload", async () => {
    const r = await rows();
    expect(r[SINGLE.toBase58()].max_portfolio_assets).toBe(1);
    expect(r[MULTI.toBase58()].max_portfolio_assets).toBe(4);
  });

  it("carries withdraw_only from the env list entry, only on that market", async () => {
    vi.stubEnv("NEXT_PUBLIC_V22_MARKETS_JSON", JSON.stringify([{ slab: SINGLE.toBase58(), symbol: "JUP-OLD", name: "JUP (old)", mainnet_ca: MINT.toBase58(), dex_pool_address: MINT.toBase58(), lp_portfolio_address: MINT.toBase58(), withdraw_only: true }]));
    const r = await rows();
    expect(r[SINGLE.toBase58()].withdraw_only).toBe(true);
    expect(r[SINGLE.toBase58()].symbol).toBe("JUP-OLD");
    expect(r[MULTI.toBase58()].withdraw_only).toBeUndefined();
  });
});
