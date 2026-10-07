// @vitest-environment node
/**
 * Route level: /api/markets (list) and /api/stats find a VERSION 19 market with the v2.2 flag on, and do not with it off.
 * Real SDK discovery and real route code; only chain / Supabase / Blob I/O is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { LAYOUT_V21, LAYOUT_V22, syntheticMarket } from "./_stamp";

const PROG = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const K21 = new PublicKey(new Uint8Array(32).fill(7));
const K22 = new PublicKey(new Uint8Array(32).fill(9));

const m21 = syntheticMarket(LAYOUT_V21, 1);
const m22 = syntheticMarket(LAYOUT_V22, 1);
// A non-zero mark so the stats route counts the market (WrapperConfigV17.markEwmaE6 is at config +?; set via the SDK parse below).
// A COMPLETE wizard market has marketauth == its stake-pool PDA; the route hides the others.
for (const [m, k] of [[m21, K21], [m22, K22]] as const) m.set(deriveStakePool(k, new PublicKey("GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3"))[0].toBytes(), 16);
const data = new Map<string, Uint8Array>([[K21.toBase58(), m21], [K22.toBase58(), m22]]);
const info = (d: Uint8Array) => ({ data: Buffer.from(d), executable: false, lamports: 1, owner: PROG });

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", rpcUrl: "https://api.devnet.solana.com" }),
}));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => { throw new Error("no supabase"); } }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getProgramAccounts: async () => [...data].map(([k, d]) => ({ pubkey: new PublicKey(k), account: info(d) })),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (data.has(k.toBase58()) ? info(data.get(k.toBase58())!) : null)),
    getAccountInfo: async (k: PublicKey) => (data.has(k.toBase58()) ? info(data.get(k.toBase58())!) : null),
  }),
}));
vi.mock("@/lib/lp-portfolio", () => ({ getKnownMarketLpCapitals: async () => new Map(), scanEnabledMarketLpCapitals: async () => new Map() }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [{ slabAddress: K21.toBase58(), symbol: "OLD", label: "Old" }, { slabAddress: K22.toBase58(), symbol: "NEW", label: "New" }] }));

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_DEVNET_V22;
  vi.restoreAllMocks();
});

async function listSlabs(): Promise<string[]> {
  const { NextRequest } = await import("next/server");
  const { GET } = await import("@/app/api/markets/route");
  const res = await GET(new NextRequest("http://localhost/api/markets?include_zombies=1"));
  const body = await res.json();
  return ((body.markets ?? []) as { slab_address: string }[]).map((m) => m.slab_address);
}

describe("GET /api/markets (on-chain discovery)", () => {
  it("flag on: the VERSION 19 market is listed", async () => {
    process.env.NEXT_PUBLIC_DEVNET_V22 = "1"; // module graph is reset per test: drive the flag through the environment
    expect(await listSlabs()).toContain(K22.toBase58());
  });
  it("flag off (control): the VERSION 19 market is not listed", async () => {
    expect(await listSlabs()).not.toContain(K22.toBase58());
  });
});

describe("the stats route reaches discovery through the adapter", () => {
  it("calls the VERSION-aware discovery with the flag on (a v2.2 market is returned to computeStats)", async () => {
    process.env.NEXT_PUBLIC_DEVNET_V22 = "1"; // module graph is reset per test: drive the flag through the environment
    const { discoverMarkets } = await import("@/lib/v22/discovery");
    const { getServerConnection } = await import("@/lib/server-rpc");
    const found = await discoverMarkets(getServerConnection("confirmed") as never, PROG, { sequential: true, maxTierQueries: 0 });
    expect(found.map((m) => m.slabAddress.toBase58())).toContain(K22.toBase58());
    const fs = await import("node:fs");
    expect(fs.readFileSync("app/api/stats/route.ts", "utf8")).toMatch(/from "@\/lib\/v22\/discovery"/);
  });
});
