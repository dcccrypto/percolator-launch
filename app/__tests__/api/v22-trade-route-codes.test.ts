// @vitest-environment node
/**
 * POST /api/v22/trade with the REAL builder (only the chain reads are faked): pins the two error answers the bot-API fixes
 * changed on this route (R19). Both are deliberate and listed in docs/ideas/bot-trading-rails.md:
 *   (a) an LP scan that fails on RPC answers 503 `rpc` (it used to answer 503 `no_lp`); a market with no LP is still `no_lp`.
 *   (b) the owner's account is checked before the LP: no portfolio answers 409 `no_portfolio` whatever the LP scan would say
 *       (it used to answer 503 `no_lp` on a market without an LP).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";

const fx = JSON.parse(readFileSync(join(__dirname, "../fixtures/v22-trade-build/gato-market.json"), "utf8")) as { slab: string; owner: string; data: string };
const OWNER = Keypair.generate().publicKey;
const h = vi.hoisted(() => ({ portfolio: null as PublicKey | null, lpScans: 0, lpError: null as Error | null }));

vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true, remaining: 1, retryAfterSecs: 0 }) }),
}));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async () => ({ owner: new PublicKey(fx.owner), data: Buffer.from(fx.data, "base64"), lamports: 1, executable: false }),
  }),
}));
vi.mock("@/lib/programAllowlist", () => ({ assertKnownProgram: () => undefined }));
vi.mock("@/lib/owner-portfolio", () => ({ findOwnerPortfolio: vi.fn(async () => h.portfolio) }));
vi.mock("@/lib/v22/trade-accounts", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/trade-accounts")>()),
  resolveLpTradeAccounts: vi.fn(async () => {
    h.lpScans++;
    throw h.lpError ?? new Error("No LP portfolio with an active matcher config found for this market.");
  }),
}));

import { POST } from "@/app/api/v22/trade/route";
import { __clearTradeBuildCacheForTest } from "@/lib/v22/trade-build";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const post = () => POST(new NextRequest("http://x/api/v22/trade", { method: "POST", body: JSON.stringify({ owner: OWNER.toBase58(), market: fx.slab, size: "1000000" }) }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  __setDevnetV22ForTest(true);
  __clearTradeBuildCacheForTest();
  h.portfolio = null;
  h.lpScans = 0;
  h.lpError = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
});

describe("/api/v22/trade error answers changed by the bot-API fixes (R19)", () => {
  it("(b) no portfolio is 409 no_portfolio, and the LP is not even scanned", async () => {
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_portfolio");
    expect(h.lpScans).toBe(0);
  });
  it("(a) an LP scan that fails on RPC is 503 rpc with fixed text (was no_lp)", async () => {
    h.portfolio = Keypair.generate().publicKey;
    h.lpError = new Error("Failed to scan LP portfolio accounts on-chain: 429 Too Many Requests https://secret.example/?api-key=abcd");
    const res = await post();
    const body = await res.json();
    expect([res.status, body.error]).toEqual([503, "rpc"]);
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("a market that really has no LP is still 503 no_lp", async () => {
    h.portfolio = Keypair.generate().publicKey;
    const res = await post();
    expect([res.status, (await res.json()).error]).toEqual([503, "no_lp"]);
    expect(h.lpScans).toBe(1);
  });
});
