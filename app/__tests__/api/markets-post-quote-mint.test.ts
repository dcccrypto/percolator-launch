/**
 * POST /api/markets also accepts a dex_pool_address. A pool quoted in a token that is neither
 * WSOL nor a USD stable is refused (2026-10-02 SI/MM) BEFORE any slab / DB work; a USD-priceable
 * pool proceeds to the on-chain slab check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type PoolAccount, METEORA, MM, WSOL, meteoraPool } from "../lib/pool-quote-gate-fixtures";

const h = vi.hoisted(() => ({ pool: null as PoolAccount | null }));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ rpcUrl: "https://api.devnet.solana.com", network: "devnet", programId: "11111111111111111111111111111111" }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
const mockSupabase = {
  from: vi.fn().mockReturnThis(),
  insert: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
  select: vi.fn().mockReturnThis(),
  single: vi.fn().mockResolvedValue({ data: { slab_address: "test" }, error: null }),
};
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => mockSupabase }));
vi.mock("@solana/web3.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...real,
    Connection: class {
      async getAccountInfo() {
        throw new Error("mock RPC error");
      }
      async getMultipleAccountsInfo(ks: unknown[]) {
        return ks.map(() => (h.pool ? { owner: new real.PublicKey(h.pool.owner), data: Buffer.from(h.pool.data) } : null));
      }
    },
  };
});

const BYPASS = "test-bypass-secret";
process.env.MARKETS_AUTH_BYPASS_SECRET = BYPASS;
process.env.MARKETS_AUTH_BYPASS_ENABLED = "true";

const BASE = {
  slab_address: "GRMMNsNPM1GbgxFh3S34f3jvUX6jPbPiH3oxopnDFiWM",
  mint_address: "DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs",
  deployer: "DHd11N5JVQmGdMBWf6Mnu1daFGn8j3ChCHwwYAcseD5N",
  dex_pool_address: "9GkbbuLJzy5QNeVoNUfSYsqJkAsLCcSgimfkN2zzCMhG",
};
const req = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/markets", { method: "POST", headers: { "Content-Type": "application/json", "x-markets-bypass": BYPASS }, body: JSON.stringify(body) });

describe("POST /api/markets: non-USD-quoted pool", () => {
  let POST: (r: Request) => Promise<Response>;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("@/app/api/markets/route");
    POST = mod.POST as unknown as (r: Request) => Promise<Response>;
  });

  it("MM-quoted Meteora pool: 400 quoted-in-another-token, slab never checked", async () => {
    h.pool = { owner: METEORA, data: meteoraPool(MM) };
    const res = await POST(req(BASE));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/quoted in another token/);
  });

  it("WSOL-quoted pool passes the gate and reaches the on-chain slab check", async () => {
    h.pool = { owner: METEORA, data: meteoraPool(WSOL) };
    const res = await POST(req(BASE));
    expect((await res.json()).error).toMatch(/failed to verify slab on-chain/i);
  });

  it("mainnet RPC down: not blocked by this gate (this route does not feed the keeper)", async () => {
    h.pool = null; // account missing -> class "missing", not "non-usd-quote"
    const res = await POST(req(BASE));
    expect((await res.json()).error).toMatch(/failed to verify slab on-chain/i);
  });
});
