// @vitest-environment node
/**
 * The mobile create-market route on v2.2 (flag on): ONE slot at the v2.2 stride (4,059 B), InitMarket's maxPortfolioAssets 1 (cap 4), SetMatcherConfig's
 * frontier 2; TX4 (the non-fatal Earn group) carries tag 74 with the collateral mint as account [6] and tag 122 naming the share token from the optional
 * `symbol`. The load-bearing TX3 never touches Metaplex. Flag off: the v2.1 transactions exactly (pinned beside this file by one-slot-launch.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { IX_TAG } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { assetSlotsForSlabLen } from "@/lib/create-market-args";
import { decodeInitMarketData } from "@/lib/launch-recovery";
import { METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22 } from "@/lib/v22/sdk";

// The route's own 5 req/min limiter is not under test here.
vi.mock("@/lib/create-market-rate-limit", () => ({ checkCreateMarketRateLimit: async () => ({ allowed: true, retryAfterSecs: 0 }), CREATE_MARKET_RATE_LIMIT: 5 }));

const rent = (bytes: number) => (bytes + 128) * 5080;
const originalNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
const MINT = Keypair.generate().publicKey;

beforeEach(() => {
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999_999 });
  vi.spyOn(Connection.prototype, "getMinimumBalanceForRentExemption").mockImplementation(async (n: number) => rent(n));
});
afterEach(() => {
  vi.restoreAllMocks();
  __setDevnetV22ForTest(null);
  if (originalNetwork === undefined) delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  else process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalNetwork;
});

async function post(extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/mobile/create-market/route");
  const res = await POST(
    new NextRequest("http://localhost/api/mobile/create-market", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deployer: Keypair.generate().publicKey.toBase58(), mint: MINT.toBase58(), tier: "small", name: "Mobile", oracle_mode: "admin", initial_price_e6: "1000000", ...extra }),
    }),
  );
  return res;
}
async function txsOf(res: Response) {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return (JSON.parse(text) as { unsigned_txs: string[] }).unsigned_txs.map((e) => Transaction.from(Buffer.from(e, "base64")));
}

describe("flag ON", () => {
  it("one slot at the v2.2 stride; TX4 = 74 (7 accounts, [6] = the mint), 122 (ticker from the symbol), ATA, 75, 75", async () => {
    __setDevnetV22ForTest(true);
    const txs = await txsOf(await post({ symbol: "wif" }));
    const ixs = txs.flatMap((t) => t.instructions);
    const slab = ixs.filter((i) => i.programId.equals(SystemProgram.programId) && i.data.readUInt32LE(0) === 3).map((i) => SystemInstruction.decodeCreateWithSeed(i)).filter((c) => assetSlotsForSlabLen(c.space) !== null);
    expect(slab).toHaveLength(1);
    expect(slab[0].space).toBe(4_059);
    expect(slab[0].lamports).toBe(rent(4_059));
    const init = ixs.find((i) => i.data.length === 219 && i.data[0] === IX_TAG.InitMarket)!;
    expect(decodeInitMarketData(init.data)!.maxPortfolioAssets).toBe(1);
    const tx4 = txs[txs.length - 1]!;
    const wrapper = tx4.instructions.find((i) => i.data[0] === IX_TAG.CreateLpVault)!.programId;
    const tags = tx4.instructions.filter((i) => i.programId.equals(wrapper)).map((i) => i.data[0]);
    expect(tags).toEqual([IX_TAG.CreateLpVault, 122, IX_TAG.DepositToLpVault, IX_TAG.DepositToLpVault]);
    const i74 = tx4.instructions.find((i) => i.data[0] === IX_TAG.CreateLpVault)!;
    expect(i74.keys).toHaveLength(7);
    expect(i74.keys[6].pubkey.equals(MINT)).toBe(true);
    const i122 = tx4.instructions.find((i) => i.programId.equals(wrapper) && i.data[0] === 122)!;
    expect(Buffer.from(i122.data).toString("hex")).toBe("7a03" + Buffer.from("WIF").toString("hex"));
    // the load-bearing groups never touch Metaplex
    const meta = METAPLEX_TOKEN_METADATA_PROGRAM_ID_V22.toBase58();
    for (const t of txs.slice(0, -1)) expect(t.instructions.some((i) => i.keys.some((k) => k.pubkey.toBase58() === meta))).toBe(false);
  });
  it("no symbol: the generic form; a bad symbol is a 400 before anything is built", async () => {
    __setDevnetV22ForTest(true);
    const txs = await txsOf(await post());
    const tx4 = txs[txs.length - 1]!;
    const i122 = tx4.instructions.find((i) => i.data[0] === 122 && i.data.length === 2)!;
    expect([...i122.data]).toEqual([122, 0]);
    for (const symbol of ["x".repeat(21), 5, {}, ["a"]]) {
      const res = await post({ symbol });
      expect(res.status).toBe(400);
    }
  });
});

describe("flag OFF", () => {
  it("the v2.1 transactions: 3,675 B slab, TX4 = 74 with six accounts, no tag 122, the symbol field changes nothing", async () => {
    __setDevnetV22ForTest(false);
    const a = await txsOf(await post());
    const b = await txsOf(await post({ symbol: "wif" }));
    for (const txs of [a, b]) {
      const tx4 = txs[txs.length - 1]!;
      const i74 = tx4.instructions.find((i) => i.data[0] === IX_TAG.CreateLpVault)!;
      expect(i74.keys).toHaveLength(6);
      expect(tx4.instructions.some((i) => i.programId.equals(i74.programId) && i.data[0] === 122)).toBe(false);
      const slab = txs.flatMap((t) => t.instructions).filter((i) => i.programId.equals(SystemProgram.programId) && i.data.readUInt32LE(0) === 3).map((i) => SystemInstruction.decodeCreateWithSeed(i)).filter((c) => assetSlotsForSlabLen(c.space) !== null);
      expect(slab[0].space).toBe(3_675);
    }
  });
});
