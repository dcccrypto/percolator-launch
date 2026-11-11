// @vitest-environment node
/**
 * r7: POST /api/markets refuses a registered pool that differs from the dex_pool the slab pins on-chain (layouts that carry one).
 * Route-level: only chain / DB I/O and the SDK slab parsers are mocked; the token-identity check is stubbed (it is covered elsewhere).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ pinned: null as string | null, collateral: "", deployer: "" }));
const PROGRAM = "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ";

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
process.env.MARKETS_AUTH_BYPASS_SECRET = "test-bypass-secret";
process.env.MARKETS_AUTH_BYPASS_ENABLED = "true";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", programId: PROGRAM, vaultProgramId: PROGRAM, matcherProgramId: "11111111111111111111111111111111" }) }));
vi.mock("@/lib/upstash-rate-limit", () => ({ createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }) }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => [], MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => { throw new Error("no db"); } }));
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<object>()), classifyPoolsByOwner: async () => ({}) }));
vi.mock("@/lib/v22/stablecoin-resolve", async (orig) => ({ ...(await orig<object>()), checkStablecoinUnderlying: async () => ({ ok: true }) }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getAccountInfo: async () => ({ owner: new (await_pk())(PROGRAM), data: Buffer.alloc(256), lamports: 1, executable: false }) }),
}));
function await_pk() { return PublicKeyCtor.value as unknown as new (s: string) => unknown; }
const PublicKeyCtor = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  const { PublicKey } = await import("@solana/web3.js");
  return {
    ...real,
    parseHeader: () => ({ admin: new PublicKey(h.deployer) }),
    parseConfig: () => ({ collateralMint: new PublicKey(h.collateral), oracleAuthority: new PublicKey(h.deployer), dexPool: h.pinned ? new PublicKey(h.pinned) : null }),
  };
});

const web3 = await import("@solana/web3.js");
PublicKeyCtor.value = web3.PublicKey;
const { Keypair } = web3;
const setV22 = (on: boolean | null) => { if (on === null) delete process.env.NEXT_PUBLIC_V22; else process.env.NEXT_PUBLIC_V22 = on ? "1" : "0"; };
const kp = () => Keypair.generate().publicKey.toBase58();
const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";

async function register(pool: string) {
  h.collateral = kp();
  h.deployer = kp();
  const { POST } = await import("@/app/api/markets/route");
  const res = await POST(new Request("http://localhost/api/markets", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-markets-bypass": "test-bypass-secret" },
    body: JSON.stringify({ slab_address: kp(), mint_address: h.collateral, deployer: h.deployer, mainnet_ca: CONTROL, dex_pool_address: pool }),
  }) as unknown as NextRequest);
  return { status: res.status, error: String(((await res.json()) as { error?: string }).error ?? "") };
}

beforeEach(() => { vi.resetModules(); setV22(true); h.pinned = null; });
afterEach(() => setV22(null));

describe("POST /api/markets: registered pool vs the slab's pinned dex_pool", () => {
  it("a different pool is refused (400)", async () => {
    h.pinned = kp();
    const r = await register(kp());
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/pinned to on-chain/i);
  });
  it("the same pool, or a slab that pins none, is not refused for this reason", async () => {
    const p = kp();
    h.pinned = p;
    expect((await register(p)).error).not.toMatch(/pinned to on-chain/i);
    h.pinned = null;
    expect((await register(kp())).error).not.toMatch(/pinned to on-chain/i);
  });
  it("v2.2 off: not applied", async () => {
    setV22(false);
    h.pinned = kp();
    expect((await register(kp())).error).not.toMatch(/pinned to on-chain/i);
  });
});
