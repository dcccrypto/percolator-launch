// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * keeper-register is the write that makes the keeper price (register-poll admits) a market. On v2.2 it refuses a dollar-stablecoin
 * mainnetCA (owner 2026-11-09) and writes nothing; off v2.2 it is unchanged. Scaffold: keeper-register-quote-mint.test.ts.
 */
const h = vi.hoisted(() => ({ rowWrites: 0, blobWrites: 0 }));
process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
process.env.ADMIN_API_SECRET = "stable-test-secret";

vi.mock("@/lib/market-registration", () => ({ upsertRegisteredMarketRow: vi.fn(async () => { h.rowWrites++; return { ok: true, action: "inserted", keeperActive: true }; }) }));
vi.mock("@/lib/playground-registered-markets", () => ({ upsertRegisteredMarket: vi.fn(async () => { h.blobWrites++; }) }));
vi.mock("@/lib/token-logo", () => ({ resolveTokenLogo: async () => null }));
vi.mock("@/lib/supabase", () => ({ getServerNetwork: () => "devnet", getServiceClient: () => ({}) }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";
const { Keypair } = await import("@solana/web3.js");

async function register(mainnetCA: string) {
  const { POST } = await import("@/app/api/playground/keeper-register/route");
  const res = await POST(new NextRequest("http://localhost/api/playground/keeper-register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": "stable-test-secret" },
    body: JSON.stringify({ slabAddress: Keypair.generate().publicKey.toBase58(), dexPoolAddress: Keypair.generate().publicKey.toBase58(), dexType: "pumpswap", mainnetCA, symbol: "TEST", deployer: Keypair.generate().publicKey.toBase58() }),
  }));
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

beforeEach(() => { vi.resetModules(); h.rowWrites = 0; h.blobWrites = 0; });
afterEach(() => { delete process.env.NEXT_PUBLIC_V22; });

describe("keeper-register: stablecoin underlyings", () => {
  it.each([["USDC", USDC], ["PYUSD", PYUSD]])("v2.2 on, %s: 400 with the reason, nothing written", async (_n, ca) => {
    process.env.NEXT_PUBLIC_V22 = "1";
    const { status, body } = await register(ca);
    expect(status).toBe(400);
    expect(body.error).toMatch(/dollar stablecoin/i);
    expect(h.rowWrites + h.blobWrites).toBe(0);
  });

  it("v2.2 off: not refused by this gate", async () => {
    process.env.NEXT_PUBLIC_V22 = "0";
    const { body } = await register(USDC);
    expect(body.error ?? "").not.toMatch(/dollar stablecoin/i);
  });
});
