/**
 * v2.2 (owner 2026-11-09): dollar stablecoins are not perp underlyings. Server side of the UI block (#3779):
 *  - POST /api/markets refuses registration when the canonical mainnet_ca is USDC / PYUSD / USDT;
 *  - GET /api/markets (registry path AND on-chain-discovery path) never lists such a row;
 *  - /api/stats counts the same listed set;
 *  - POST /api/mobile/create-market refuses a stablecoin `mint`.
 * Off v2.2 nothing changes. Drives the real route handlers; only chain / DB I/O is mocked.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
// vi.resetModules() gives the route a fresh flag module, so the flag is driven through the environment it reads.
const setV22 = (on: boolean | null) => { if (on === null) delete process.env.NEXT_PUBLIC_V22; else process.env.NEXT_PUBLIC_V22 = on ? "1" : "0"; };

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, registered: [] as unknown[], discovered: [] as unknown[] }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", matcherProgramId: "11111111111111111111111111111111" }),
}));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => h.rows, MARKET_SELECT_FIELDS: "" }));
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
  select: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
};
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => mockSupabase }));
vi.mock("@/lib/upstash-rate-limit", () => ({ createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }) }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => h.registered }));
vi.mock("@/lib/v22/discovery", async (orig) => ({ ...(await orig<typeof import("@/lib/v22/discovery")>()), discoverMarkets: async () => h.discovered }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null), getAccountInfo: async () => { throw new Error("mock RPC error"); } }),
}));
vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...real,
    Connection: class {
      async getAccountInfo() { throw new Error("mock RPC error"); }
      async getMultipleAccountsInfo(ks: unknown[]) { return ks.map(() => null); }
    },
  };
});

const BYPASS = "test-bypass-secret";
process.env.MARKETS_AUTH_BYPASS_SECRET = BYPASS;
process.env.MARKETS_AUTH_BYPASS_ENABLED = "true";

const BASE = {
  slab_address: "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM",
  mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
  deployer: "DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N",
};
const post = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/markets", { method: "POST", headers: { "Content-Type": "application/json", "x-markets-bypass": BYPASS }, body: JSON.stringify(body) });

const row = (slab: string, symbol: string, mainnet_ca: string | null) => ({
  slab_address: slab, symbol, decimals: 6, last_price: 1, volume_24h: 1_000_000, trade_count_24h: 2, vault_balance: 3_000_000_000, c_tot: 2_000_000_000,
  total_accounts: 2, total_open_interest: 1_000_000, total_open_interest_usd: 2, is_complete: true, oracle_mode: "admin", mainnet_ca,
});
const S1 = "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ";
const S2 = "8XwbXQ6oZ1JEnwFXsuS3AqYEYV17Msmd7hv2VUxjLbfR";
const S3 = "8zTWNoYrWgBdSnGCabL2ZqBtWjqq4qAwy9kVaN3582pL";
const S4 = "FQHF251LayhfnspwVukKsEckcW8t4ysBovu9HTfEsxty";

describe.each([
  ["v2.2 on", true],
  ["v2.2 off", false],
] as const)("stablecoin block server side (%s)", (_n, on) => {
  beforeEach(() => { vi.resetModules(); setV22(on); h.rows = []; h.registered = []; h.discovered = []; });
  afterEach(() => setV22(null));

  describe("POST /api/markets", () => {
    for (const [name, ca] of [["USDC", USDC], ["PYUSD", PYUSD], ["USDT", USDT]] as const) {
      it(`${name} mainnet_ca: ${on ? "400 with the reason, before any slab / DB work" : "not refused (reaches the slab check)"}`, async () => {
        const { POST } = await import("@/app/api/markets/route");
        const res = await POST(post({ ...BASE, mainnet_ca: ca }) as unknown as NextRequest);
        const err = String((await res.json()).error);
        if (on) {
          expect(res.status).toBe(400);
          expect(err).toMatch(/dollar stablecoin/i);
        } else {
          expect(err).not.toMatch(/dollar stablecoin/i);
        }
      });
    }

    it("a normal token is not refused by this gate", async () => {
      const { POST } = await import("@/app/api/markets/route");
      const res = await POST(post({ ...BASE, mainnet_ca: CONTROL }) as unknown as NextRequest);
      expect(String((await res.json()).error)).not.toMatch(/dollar stablecoin/i);
    });

    it("no mainnet_ca: this gate does not fire (documented gap: a pool-only POST is not resolved to its base mint)", async () => {
      const { POST } = await import("@/app/api/markets/route");
      const res = await POST(post({ ...BASE }) as unknown as NextRequest);
      expect(String((await res.json()).error)).not.toMatch(/dollar stablecoin/i);
    });
  });

  describe("GET /api/markets", () => {
    it("registry path: a stablecoin row is " + (on ? "not listed" : "listed as before"), async () => {
      h.rows = [row(S1, "CTRL", CONTROL), row(S2, "USDC", USDC), row(S3, "PYU", PYUSD), row(S4, "NOCA", null)];
      const { GET } = await import("@/app/api/markets/route");
      const body = await (await GET(new NextRequest("http://localhost/api/markets?include_zombie=true"))).json();
      const slabs = (body.markets as { slab_address: string }[]).map((m) => m.slab_address);
      expect(slabs).toContain(S1);
      expect(slabs).toContain(S4);
      if (on) {
        expect(slabs).not.toContain(S2);
        expect(slabs).not.toContain(S3);
      } else {
        expect(slabs).toContain(S2);
        expect(slabs).toContain(S3);
      }
    });
  });

  describe("/api/stats parity", () => {
    it("isListedMarket drops a stablecoin row on v2.2 only", async () => {
      const { isListedMarket } = await import("@/lib/market-visibility");
      expect(isListedMarket(row(S1, "CTRL", CONTROL))).toBe(true);
      expect(isListedMarket(row(S2, "USDC", USDC))).toBe(!on);
    });
  });

  describe("POST /api/mobile/create-market", () => {
    it(`stablecoin mint: ${on ? "400 before anything is built" : "not refused by this gate"}`, async () => {
      process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
      vi.doMock("@/lib/rate-limit", async (orig) => ({ ...(await orig<object>()), checkCreateMarketRateLimit: async () => ({ allowed: true, retryAfterSecs: 0 }) }));
      const { POST } = await import("@/app/api/mobile/create-market/route");
      const mk = (mint: string) =>
        new NextRequest("http://localhost/api/mobile/create-market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deployer: BASE.deployer, mint, symbol: "X" }) });
      const res = await POST(mk(USDC));
      const err = String((await res.json()).error ?? "");
      if (on) {
        expect(res.status).toBe(400);
        expect(err).toMatch(/dollar stablecoin/i);
      } else {
        expect(err).not.toMatch(/dollar stablecoin/i);
      }
    });
  });
});
