// @vitest-environment node
/**
 * Council r5 #2, server side: the whole USD-stable class is refused on v2.2 on every create / register route, including the
 * pool-only registration (no mainnet_ca): the server resolves the pool's base mint from mainnet and checks it. Drives the real route
 * handlers; only chain / DB I/O is mocked (one account map stands in for mainnet).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUMPSWAP, METEORA, USDC, WSOL } from "../lib/pool-quote-gate-fixtures";

// The first import of the markets route is heavy, and the "v2.2 off" case runs into the route's own slab-read retries.
vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ accounts: new Map<string, { owner: string; data: Uint8Array }>(), rpcDown: false, rowWrites: 0, blobWrites: 0, dbUpdates: 0, keeperFetches: 0 }));

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
process.env.ADMIN_API_SECRET = "stable-class-secret";
process.env.KEEPER_REGISTER_SECRET = "stable-class-keeper-secret";
const BYPASS = "test-bypass-secret";
process.env.MARKETS_AUTH_BYPASS_SECRET = BYPASS;
process.env.MARKETS_AUTH_BYPASS_ENABLED = "true";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", programId: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ", vaultProgramId: "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", matcherProgramId: "11111111111111111111111111111111" }),
}));
vi.mock("@/lib/upstash-rate-limit", () => ({ createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }) }));
vi.mock("@/lib/market-registry", () => ({ loadMergedMarketRows: async () => [], MARKET_SELECT_FIELDS: "" }));
vi.mock("@/lib/playground-registered-markets", () => ({ readRegisteredMarkets: async () => [], upsertRegisteredMarket: vi.fn(async () => { h.blobWrites++; }) }));
vi.mock("@/lib/market-registration", () => ({ upsertRegisteredMarketRow: vi.fn(async () => { h.rowWrites++; return { ok: true, action: "inserted", keeperActive: true }; }) }));
vi.mock("@/lib/token-logo", () => ({ resolveTokenLogo: async () => null }));
const supabase = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
  update: vi.fn(() => { h.dbUpdates++; return supabase; }),
  eq: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: { slab_address: "s", mainnet_ca: "x" }, error: null }),
};
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => supabase }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({ getMultipleAccountsInfo: async (ks: unknown[]) => ks.map(() => null), getAccountInfo: async () => { throw new Error("mock RPC error"); } }),
}));
vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  class Connection {
    async getAccountInfo() { throw new Error("mock RPC error"); }
    async getMultipleAccountsInfo(keys: Array<{ toBase58(): string }>) {
      if (h.rpcDown) throw new Error("rpc down");
      return keys.map((k) => { const a = h.accounts.get(k.toBase58()); return a ? { owner: new real.PublicKey(a.owner), data: Buffer.from(a.data), lamports: 1, executable: false } : null; });
    }
  }
  return { ...real, Connection };
});

const { Keypair, PublicKey } = await import("@solana/web3.js");
const { signKeeperRequest } = await import("@/lib/keeper-hmac");

const USDS = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
const FDUSD = "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u";
const USDE = "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT";
const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const USDC_PORTAL = "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM";
const SUSDE = "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN";
const CONTROL = "CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1Ujm6AkzpKoU";
const NEW_CLASS: Array<[string, string]> = [["USDS", USDS], ["FDUSD", FDUSD], ["USDe", USDE], ["USDG", USDG], ["USDCet (Wormhole)", USDC_PORTAL], ["sUSDe", SUSDE]];

const setV22 = (on: boolean | null) => { if (on === null) delete process.env.NEXT_PUBLIC_V22; else process.env.NEXT_PUBLIC_V22 = on ? "1" : "0"; };
const kp = () => Keypair.generate().publicKey.toBase58();
function pool(owner: string, base: string, quote: string): string {
  const addr = kp();
  const d = Buffer.alloc(owner === PUMPSWAP ? 301 : 904);
  const [bo, qo] = owner === PUMPSWAP ? [43, 75] : [88, 120];
  new PublicKey(base).toBuffer().copy(d, bo);
  new PublicKey(quote).toBuffer().copy(d, qo);
  h.accounts.set(addr, { owner, data: d });
  return addr;
}

const DEPLOYER = "DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N";
const postMarkets = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/markets", { method: "POST", headers: { "Content-Type": "application/json", "x-markets-bypass": BYPASS }, body: JSON.stringify({ slab_address: kp(), mint_address: kp(), deployer: DEPLOYER, ...body }) }) as unknown as NextRequest;
const errOf = async (res: Response) => String(((await res.json()) as { error?: string }).error ?? "");

beforeEach(() => { vi.resetModules(); setV22(true); h.accounts.clear(); h.rpcDown = false; h.rowWrites = h.blobWrites = h.dbUpdates = 0; });
afterEach(() => setV22(null));

describe("POST /api/markets", () => {
  it.each(NEW_CLASS)("%s as mainnet_ca: 400 with the reason", async (_n, ca) => {
    const { POST } = await import("@/app/api/markets/route");
    const res = await POST(postMarkets({ mainnet_ca: ca }));
    expect(res.status).toBe(400);
    expect(await errOf(res)).toMatch(/dollar stablecoin/i);
  });

  it("symbol-only: a client symbol / name that is a stable identity is refused even with a clean mainnet_ca (refuse-only)", async () => {
    const { POST } = await import("@/app/api/markets/route");
    for (const body of [{ mainnet_ca: CONTROL, symbol: "USDS" }, { symbol: "FDUSD" }, { mainnet_ca: CONTROL, name: "USD Coin" }]) {
      const res = await POST(postMarkets(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errOf(res)).toMatch(/dollar stablecoin/i);
    }
  });

  it.each([["PumpSwap", PUMPSWAP], ["Meteora DLMM", METEORA]])("POOL-ONLY (%s), base mint USDS / FDUSD: refused", async (_n, owner) => {
    const { POST } = await import("@/app/api/markets/route");
    for (const base of [USDS, FDUSD]) {
      const res = await POST(postMarkets({ dex_pool_address: pool(owner, base, USDC) }));
      expect(res.status, base).toBe(400);
      expect(await errOf(res)).toMatch(/dollar stablecoin/i);
    }
  });

  it("POOL-ONLY: a clean mainnet_ca is no excuse when the pool's base mint is a stable", async () => {
    const { POST } = await import("@/app/api/markets/route");
    const res = await POST(postMarkets({ mainnet_ca: CONTROL, dex_pool_address: pool(PUMPSWAP, USDS, USDC) }));
    expect(res.status).toBe(400);
    expect(await errOf(res)).toMatch(/dollar stablecoin/i);
  });

  it("r7: no pool and no mainnet_ca is refused (400) instead of skipping the check; v2.2 off is not", async () => {
    const { POST } = await import("@/app/api/markets/route");
    const res = await POST(postMarkets({ symbol: "OK" }));
    expect(res.status).toBe(400);
    expect(await errOf(res)).toMatch(/no token identity/i);
    setV22(false);
    vi.resetModules();
    const off = await import("@/app/api/markets/route");
    expect(await errOf(await off.POST(postMarkets({ symbol: "OK" })))).not.toMatch(/no token identity/i);
  });

  it("r7: the token-metadata layer fails closed: mainnet_ca only + RPC down is a retryable 503, not a pass", async () => {
    const { POST } = await import("@/app/api/markets/route");
    h.rpcDown = true;
    const res = await POST(postMarkets({ mainnet_ca: CONTROL }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
  });

  it.each([["USD+", "usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia"], ["CASH", "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH"], ["JupUSD", "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD"]])("r7: %s mint as mainnet_ca: 400", async (_n, ca) => {
    const { POST } = await import("@/app/api/markets/route");
    const res = await POST(postMarkets({ mainnet_ca: ca }));
    expect(res.status).toBe(400);
    expect(await errOf(res)).toMatch(/dollar stablecoin/i);
  });

  it("POOL-ONLY: an unreadable pool is refused (400), an RPC failure is a retryable 503; neither reaches the slab check", async () => {
    const { POST } = await import("@/app/api/markets/route");
    const missing = await POST(postMarkets({ dex_pool_address: kp() }));
    expect(missing.status).toBe(400);
    expect(await errOf(missing)).toMatch(/couldn't read this market's token/i);
    h.rpcDown = true;
    const down = await POST(postMarkets({ dex_pool_address: kp() }));
    expect(down.status).toBe(503);
  });

  it("mainnet_ca + pool: an unreadable pool is refused, and a mainnet_ca that is not the pool's base mint is 400", async () => {
    const { POST } = await import("@/app/api/markets/route");
    const unread = await POST(postMarkets({ mainnet_ca: CONTROL, dex_pool_address: kp() }));
    expect(unread.status).toBe(400);
    expect(await errOf(unread)).toMatch(/couldn't read this market's token/i);
    const mismatch = await POST(postMarkets({ mainnet_ca: CONTROL, dex_pool_address: pool(PUMPSWAP, kp(), USDC) }));
    expect(mismatch.status).toBe(400);
    expect(await errOf(mismatch)).toMatch(/not the base token of the pool/i);
  });

  it("POOL-ONLY: a normal token pool is not refused by the stablecoin gate", async () => {
    const { POST } = await import("@/app/api/markets/route");
    const res = await POST(postMarkets({ dex_pool_address: pool(METEORA, CONTROL, WSOL) }));
    expect(await errOf(res)).not.toMatch(/dollar stablecoin|couldn't read this market's token/i);
  });

  it("v2.2 off: nothing here refuses (reaches the slab check)", async () => {
    setV22(false);
    const { POST } = await import("@/app/api/markets/route");
    for (const body of [{ mainnet_ca: USDS }, { symbol: "USDC" }, { dex_pool_address: pool(PUMPSWAP, USDS, USDC) }]) {
      const res = await POST(postMarkets(body));
      expect(await errOf(res), JSON.stringify(body)).not.toMatch(/dollar stablecoin|couldn't read this market's token/i);
    }
  });
});

describe("GET /api/markets listing filter", () => {
  it("drops a row by stable symbol / name (no mainnet_ca) and by the new mints; keeps a normal row", async () => {
    const { isListedMarket } = await import("@/lib/market-visibility");
    const base = { slab_address: "3t67LQPdgiSqGvXsYff3Pzv2uHtM1zZ7f29HsnEzb6vJ", decimals: 6, last_price: 1, volume_24h: 1e6, trade_count_24h: 2, vault_balance: 3e9, c_tot: 2e9, total_accounts: 2, total_open_interest: 1e6, is_complete: true, oracle_mode: "admin" };
    expect(isListedMarket({ ...base, symbol: "CTRL", mainnet_ca: CONTROL })).toBe(true);
    expect(isListedMarket({ ...base, symbol: "CTRL", mainnet_ca: USDS })).toBe(false);
    expect(isListedMarket({ ...base, symbol: "FDUSD", mainnet_ca: null })).toBe(false);
    expect(isListedMarket({ ...base, symbol: "CTRL", name: "USD Coin", mainnet_ca: CONTROL })).toBe(false);
    setV22(false);
    vi.resetModules();
    const off = await import("@/lib/market-visibility");
    expect(off.isListedMarket({ ...base, symbol: "CTRL", mainnet_ca: USDS })).toBe(true);
  });
});

describe("POST /api/playground/keeper-register", () => {
  async function register(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/playground/keeper-register/route");
    const res = await POST(new NextRequest("http://localhost/api/playground/keeper-register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-secret": "stable-class-secret" },
      body: JSON.stringify({ slabAddress: kp(), dexType: "pumpswap", symbol: "TEST", deployer: kp(), ...body }),
    }));
    return { status: res.status, error: await errOf(res) };
  }
  it.each(NEW_CLASS)("%s as mainnetCA: 400, nothing written", async (_n, ca) => {
    const r = await register({ dexPoolAddress: kp(), mainnetCA: ca });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dollar stablecoin/i);
    expect(h.rowWrites + h.blobWrites).toBe(0);
  });
  it.each([["PumpSwap", PUMPSWAP], ["Meteora DLMM", METEORA]])("POOL-ONLY (%s), base USDS: 400 as a stablecoin, nothing written", async (_n, owner) => {
    const r = await register({ dexPoolAddress: pool(owner, USDS, USDC) });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dollar stablecoin/i);
    expect(h.rowWrites + h.blobWrites).toBe(0);
  });
  it("mainnetCA that is not the pool's base mint: 400 mismatch, nothing written", async () => {
    const r = await register({ dexPoolAddress: pool(PUMPSWAP, kp(), USDC), mainnetCA: CONTROL });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/not the base token of the pool/i);
    expect(h.rowWrites + h.blobWrites).toBe(0);
  });
  it("a stable symbol (client) with no mainnetCA is refused; v2.2 off is not", async () => {
    const r = await register({ dexPoolAddress: kp(), symbol: "USDS" });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dollar stablecoin/i);
    setV22(false);
    vi.resetModules();
    expect((await register({ dexPoolAddress: kp(), symbol: "USDS" })).error).not.toMatch(/dollar stablecoin/i);
  });
});

describe("POST /api/oracle-keeper/register (hot-registers with the keeper)", () => {
  async function hit(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    const { timestamp, signature } = signKeeperRequest("stable-class-keeper-secret", raw, { method: "POST", path: "/api/oracle-keeper/register" });
    const { POST } = await import("@/app/api/oracle-keeper/register/route");
    const res = await POST(new NextRequest("http://localhost/api/oracle-keeper/register", {
      method: "POST", headers: { "content-type": "application/json", "x-keeper-timestamp": timestamp, "x-keeper-signature": signature }, body: raw,
    }));
    return { status: res.status, error: await errOf(res) };
  }
  it.each(NEW_CLASS)("%s as mainnetCA: 400 before any DB write", async (_n, ca) => {
    const r = await hit({ slabAddress: kp(), mainnetCA: ca });
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/dollar stablecoin/i);
    expect(h.dbUpdates).toBe(0);
  });
  it("r7: metadata RPC failure fails closed (503), nothing written", async () => {
    h.rpcDown = true;
    const r = await hit({ slabAddress: kp(), mainnetCA: CONTROL, symbol: "OK" });
    expect(r.status).toBe(503);
    expect(h.dbUpdates).toBe(0);
  });
  it("a client symbol that is a stable ticker is refused; a normal token reaches the DB write", async () => {
    expect((await hit({ slabAddress: kp(), mainnetCA: CONTROL, symbol: "USDC" })).status).toBe(400);
    const ok = await hit({ slabAddress: kp(), mainnetCA: CONTROL, symbol: "OK" });
    expect(ok.error).not.toMatch(/dollar stablecoin/i);
    expect(h.dbUpdates).toBe(1);
  });
});

describe("POST /api/mobile/create-market", () => {
  it.each(NEW_CLASS)("%s mint: 400 before anything is built; a stable symbol is refused too", async (_n, mint) => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    vi.doMock("@/lib/rate-limit", async (orig) => ({ ...(await orig<object>()), checkCreateMarketRateLimit: async () => ({ allowed: true, retryAfterSecs: 0 }) }));
    const { POST } = await import("@/app/api/mobile/create-market/route");
    const mk = (b: Record<string, unknown>) => new NextRequest("http://localhost/api/mobile/create-market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deployer: DEPLOYER, symbol: "X", ...b }) });
    const a = await POST(mk({ mint }));
    expect(a.status).toBe(400);
    expect(await errOf(a)).toMatch(/dollar stablecoin/i);
    const b = await POST(mk({ mint: CONTROL, symbol: "USDS" }));
    expect(b.status).toBe(400);
    expect(await errOf(b)).toMatch(/dollar stablecoin/i);
  });
});
