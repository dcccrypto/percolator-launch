// @vitest-environment node
/**
 * Audit R-app-3562 M1: the public mobile create-market route builds its own launch. On a v2.2 deploy InitMarket writes
 * permissionless_resolve_stale_slots = 0, so a market launched here without tag 38 could never be resolved by anyone (S1-7).
 * Behaviour test: call the route and decode the transaction it returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

vi.mock("@/lib/get-client-ip", () => ({ getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/create-market-rate-limit", () => ({ checkCreateMarketRateLimit: async () => ({ allowed: true, retryAfterSecs: 0 }), CREATE_MARKET_RATE_LIMIT: 5 }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

import { POST } from "@/app/api/mobile/create-market/route";

async function launchTx0(): Promise<{ tx0: Transaction; deployer: string; slab: string; wrapper: PublicKey }> {
  const deployer = Keypair.generate().publicKey.toBase58();
  const res = await POST(
    new NextRequest("http://localhost/api/mobile/create-market", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deployer, mint: Keypair.generate().publicKey.toBase58(), tier: "small", name: "Stale window", oracle_mode: "admin", initial_price_e6: "1000000" }),
    }),
  );
  const text = await res.text();
  if (res.status !== 200) throw new Error(`route ${res.status}: ${text} ${String(sentry.captureException.mock.calls[0]?.[0])}`);
  const body = JSON.parse(text) as { slab_address: string; unsigned_txs: string[] };
  const cfg = getConfig();
  return { tx0: Transaction.from(Buffer.from(body.unsigned_txs[0]!, "base64")), deployer, slab: body.slab_address, wrapper: new PublicKey((cfg.programsBySlabTier?.small as string | undefined) ?? (cfg.programId as string)) };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DEFAULT_NETWORK", "devnet");
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999_999 });
  vi.spyOn(Connection.prototype, "getMinimumBalanceForRentExemption").mockResolvedValue(1_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __setDevnetV22ForTest(null);
});

describe("mobile create-market route: v2.2 stale window (tag 38)", () => {
  it("flag ON: tx0 carries exactly one tag 38 right after InitMarket + SetNftProgramId, signed by the deployer, 18,000 slots", async () => {
    __setDevnetV22ForTest(true);
    const { tx0, deployer, slab, wrapper } = await launchTx0();
    const wix = tx0.instructions.filter((i) => i.programId.equals(wrapper));
    const tags = wix.map((i) => i.data[0]);
    expect(tags.filter((t) => t === 38)).toHaveLength(1);
    expect(tags.indexOf(38)).toBeGreaterThan(tags.indexOf(0)); // after InitMarket (marketauth is still the deployer)
    const ix = wix[tags.indexOf(38)]!;
    expect(ix.data.length).toBe(33);
    const d = Buffer.from(ix.data);
    expect(d.readBigUInt64LE(1)).toBe(2n); // fresh one-asset market: frontier = slots + 1
    expect(d.readBigUInt64LE(9)).toBe(18_000n);
    expect(d.readBigUInt64LE(17)).toBe(216_000n);
    expect(d.readBigUInt64LE(25)).toBe(1n);
    // identity and order (flags in a decoded Transaction are message-level, unioned across instructions)
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([deployer, slab]);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(tx0.feePayer?.toBase58()).toBe(deployer);
  });

  it("flag OFF: the v2.1 launch is unchanged (no tag 38)", async () => {
    __setDevnetV22ForTest(false);
    const { tx0, wrapper } = await launchTx0();
    expect(tx0.instructions.filter((i) => i.programId.equals(wrapper)).map((i) => i.data[0])).not.toContain(38);
  });
});
