// @vitest-environment node
/**
 * Every wizard launch (legacy and vault-LP) creates a ONE-slot market. Security review 2026-10-08
 * ("Deployed v1"): on the deployed wrapper an account holding many legs in one market can become
 * impossible to settle or liquidate, and only slot 0 of the 14 a legacy launch allocated is ever used.
 *
 * These pin: what a legacy launch builds (InitMarket args, account length, rent); that a market that
 * ALREADY exists keeps the slot count it was created with; that the mobile route's three values agree;
 * that discovery and the readers do not depend on a market having more than one slot; and a negative
 * control for each.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import {
  IX_TAG,
  MAX_BACKING_BUCKET_EXPIRY_SLOT,
  SLAB_TIERS_V12_19,
  discoverMarkets,
  encodeInitMarket,
  encodeSetMatcherConfig,
  v17MarketAccountLen,
} from "@percolatorct/sdk";
import {
  LAUNCH_ASSET_SLOTS,
  assetSlotsForSlabLen,
  maxPortfolioAssets,
  buildV17InitMarketArgs,
  initialAssetGenerationFrontier,
  marketAssetSlotsFor,
  slabSizeFor,
} from "@/lib/create-market-args";
import { deriveMarketParams } from "@/lib/market-params";
import { buildM1Instructions } from "@/lib/create-market-m1";
import { decodeInitMarketData } from "@/lib/launch-recovery";
import { decodeMarketLiveness } from "@/lib/self-heal";
import { computeCreateMarketSolCost } from "@/components/create/CostEstimate";
import { ONE_SLOT_LEN, marketLen } from "../helpers/v22-account-lens";

const ONE = ONE_SLOT_LEN();
const FOURTEEN = v17MarketAccountLen(14); // the v2.1 14-slot length (33,900 B)
// The largest market the ACTIVE program creates: 14 slots on v2.1; the v2.2 wrapper caps maxPortfolioAssets at 4 (WRAPPER_MAX_PORTFOLIO_ASSETS; InitMarket
// with 5 is refused 14 on devnet, lib/v22/trade-refusal-9-copy.ts), so a 14-slot v2.2 market cannot exist and these tests use the cap instead.
const MANY_N = maxPortfolioAssets();
const MANY = marketLen(MANY_N);
/** getMinimumBalanceForRentExemption on devnet and mainnet: (bytes + 128) x 5080 lamports. */
const rent = (bytes: number) => (bytes + 128) * 5080;

describe("what a legacy launch builds", () => {
  it("one slot: sizes", () => {
    expect(LAUNCH_ASSET_SLOTS).toBe(1);
    expect(ONE).toBe(ONE_SLOT_LEN());
    expect(FOURTEEN).toBe(33_900);
    expect(marketAssetSlotsFor({})).toBe(1);
    expect(slabSizeFor({})).toBe(ONE);
    expect(initialAssetGenerationFrontier(1)).toBe(2n);
    expect(initialAssetGenerationFrontier(14)).toBe(15n);
  });

  it("the legacy M1 transaction: account length, rent and InitMarket's maxPortfolioAssets agree at 1", () => {
    const k = () => Keypair.generate().publicKey;
    const derived = deriveMarketParams(5, 1_000_000_000n, 1_000_000n);
    const params = { initialPriceE6: 1_000_000n, tradingFeeBps: 30 };
    const initArgs = buildV17InitMarketArgs(params, derived);
    const slabSize = slabSizeFor(params);
    const ixs = buildM1Instructions({
      programId: k(), wallet: k(), slab: k(), mint: k(), vaultAta: k(), vaultPda: k(), nftRegistry: k(),
      slabRent: rent(slabSize), slabSize, initArgs,
    });
    // createAccount: space and lamports
    const create = SystemInstruction.decodeCreateAccount(ixs[0]);
    expect(create.space).toBe(ONE_SLOT_LEN());
    expect(create.lamports).toBe(rent(ONE_SLOT_LEN()));
    // InitMarket (the wrapper ix with the 219-byte payload) names exactly that capacity
    const init = ixs.find((i) => i.data.length === 219 && i.data[0] === IX_TAG.InitMarket)!;
    expect(decodeInitMarketData(init.data)?.maxPortfolioAssets).toBe(1);
    expect(ONE_SLOT_LEN()).toBe(create.space);
  });

  it("rent saved per launch: 0.153543 SOL (172,862,240 -> 19,319,240 lamports)", () => {
    expect(rent(FOURTEEN)).toBe((FOURTEEN + 128) * 5080);
    expect(rent(ONE)).toBe(rent(ONE_SLOT_LEN()));
    expect(rent(FOURTEEN) - rent(ONE)).toBe((FOURTEEN - ONE) * 5080);
    expect(computeCreateMarketSolCost().slabRentSol).toBeCloseTo(rent(ONE_SLOT_LEN()) / 1e9, 9);
  });

  it("NEGATIVE CONTROL: a mismatched pair (14-slot account, 1-slot InitMarket) is detectable, never produced", () => {
    const args = buildV17InitMarketArgs({ initialPriceE6: 1n, tradingFeeBps: 30 }, deriveMarketParams(5, 1_000_000_000n, 1_000_000n));
    expect(args.maxPortfolioAssets).toBe(1);
    expect(marketLen(args.maxPortfolioAssets)).not.toBe(MANY);
    // And the builders cannot be handed a slab size separately any more: size derives from the slot count.
    expect(slabSizeFor({ assetSlots: MANY_N })).toBe(MANY);
    expect(buildV17InitMarketArgs({ initialPriceE6: 1n, tradingFeeBps: 30, assetSlots: MANY_N }, deriveMarketParams(5, 1_000_000_000n, 1_000_000n)).maxPortfolioAssets).toBe(MANY_N);
    // The program cap is enforced: one slot over it is refused, never built.
    expect(() => buildV17InitMarketArgs({ initialPriceE6: 1n, tradingFeeBps: 30, assetSlots: MANY_N + 1 }, deriveMarketParams(5, 1_000_000_000n, 1_000_000n))).toThrow(/exceeds the program cap/);
  });
});

describe("a market that already exists keeps the slot count it was created with", () => {
  it("the capacity is read off the account length, exactly", () => {
    for (let n = 1; n <= MANY_N; n++) expect(assetSlotsForSlabLen(marketLen(n))).toBe(n);
    for (const bad of [0, ONE - 1, ONE + 1, MANY - 1, MANY + 1, 2 * MANY, 3 * MANY, marketLen(MANY_N + 1)]) expect(assetSlotsForSlabLen(bad)).toBeNull();
  });

  it("an in-flight pre-change launch (the largest market, 14 slots on v2.1) resumes with its slot count: size, InitMarket and the matcher frontier follow", () => {
    const params = { assetSlots: assetSlotsForSlabLen(MANY)! };
    expect(marketAssetSlotsFor(params)).toBe(MANY_N);
    expect(slabSizeFor(params)).toBe(MANY);
    expect(initialAssetGenerationFrontier(marketAssetSlotsFor(params))).toBe(BigInt(MANY_N) + 1n);
  });

  it("a vault-LP market is one slot whatever it is told", () => {
    expect(marketAssetSlotsFor({ p3: {}, assetSlots: 14 })).toBe(1);
    expect(slabSizeFor({ p3: {}, assetSlots: 14 })).toBe(ONE);
  });

  it("the hook adopts the slab's capacity on every resume step and on a stuck-slab retry (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const hook = readFileSync("hooks/useCreateMarket.ts", "utf8");
    expect(hook).toContain("if (startStep > 0 && !params.p3) {");
    expect(hook).toContain("params = { ...params, assetSlots: existing };");
    expect(hook).toContain("params = { ...params, assetSlots: adopted };");
    expect(hook.match(/initialAssetGenerationFrontier\(marketAssetSlotsFor\(params\)\)/g)?.length).toBe(2);
    expect(hook).not.toMatch(/slabDataSize/);
  });
});

describe("readers do not depend on a market having more than one slot", () => {
  const MAGIC = [0, 54, 49, 86, 67, 82, 69, 80];
  /** A market account of `slots` slots: v17 magic, version 18, kind market, max_market_slots = slots. */
  function market(slots: number): Uint8Array {
    const d = new Uint8Array(marketLen(slots));
    d.set(MAGIC, 0);
    new DataView(d.buffer).setUint16(8, 18, true);
    d[10] = 1;
    // MARKET_GROUP_OFF (592) + config rel 32 + max_market_slots rel 2 (lib/self-heal.ts)
    new DataView(d.buffer).setUint32(592 + 32 + 2, slots, true);
    return d;
  }

  it("the liveness decoder returns the market's own slots: 1 -> 2 domains, 14 -> 28 (existing markets decode unchanged)", () => {
    expect(decodeMarketLiveness(market(1), 0n).buckets).toHaveLength(2);
    expect(decodeMarketLiveness(market(14), 0n).buckets).toHaveLength(28);
  });

  it("discovery finds BOTH sizes: the 1-slot size is in no slab-tier list, the magic scan has no size filter", async () => {
    const tierSizes = new Set(Object.values(SLAB_TIERS_V12_19).map((t) => t.dataSize));
    expect(tierSizes.has(ONE)).toBe(false); // so a dataSize-only scan would never see it
    expect(tierSizes.has(FOURTEEN)).toBe(false); // ...nor the 14-slot size: it is found the same way
    const one = Keypair.generate().publicKey;
    const fourteen = Keypair.generate().publicKey;
    const accounts = [
      { pubkey: one, data: market(1) },
      { pubkey: fourteen, data: market(14) },
    ];
    const calls: unknown[] = [];
    const conn = {
      // A tiny RPC: honours dataSize and memcmp filters and dataSlice, like the real one.
      getProgramAccounts: vi.fn(async (_p: PublicKey, cfg: { filters?: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[]; dataSlice?: { offset: number; length: number } }) => {
        calls.push(cfg);
        const out = accounts.filter((a) =>
          (cfg.filters ?? []).every((f) => {
            if (f.dataSize !== undefined) return a.data.length === f.dataSize;
            if (f.memcmp) {
              const want = Buffer.from(f.memcmp.bytes, "base64");
              return want.every((b, i) => a.data[f.memcmp!.offset + i] === b);
            }
            return true;
          }),
        );
        return out.map((a) => ({
          pubkey: a.pubkey,
          account: { data: Buffer.from(cfg.dataSlice ? a.data.slice(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) : a.data), lamports: 1, owner: _p, executable: false },
        }));
      }),
    } as unknown as Connection;
    const found = await discoverMarkets(conn, Keypair.generate().publicKey, { maxTierQueries: 0 });
    expect(found.map((m) => m.slabAddress.toBase58()).sort()).toEqual([one.toBase58(), fourteen.toBase58()].sort());
    // The scan that found them carries a magic filter and NO dataSize.
    expect(calls.some((c) => JSON.stringify(c).includes("memcmp") && !JSON.stringify(c).includes("dataSize"))).toBe(true);
  });

  it("NEGATIVE CONTROL: a dataSize-only scan over the tier sizes finds neither", async () => {
    const accounts = [market(1), market(14)];
    const sizes = Object.values(SLAB_TIERS_V12_19).map((t) => t.dataSize);
    expect(accounts.filter((a) => sizes.includes(a.length))).toHaveLength(0);
  });
});

describe("the mobile route's three values agree", () => {
  const originalNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999_999 });
    vi.spyOn(Connection.prototype, "getMinimumBalanceForRentExemption").mockImplementation(async (n: number) => rent(n));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNetwork === undefined) delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    else process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalNetwork;
  });

  it("account length, InitMarket maxPortfolioAssets and SetMatcherConfig's frontier all describe ONE slot", async () => {
    const { POST } = await import("@/app/api/mobile/create-market/route");
    const res = await POST(
      new NextRequest("http://localhost/api/mobile/create-market", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deployer: Keypair.generate().publicKey.toBase58(),
          mint: Keypair.generate().publicKey.toBase58(),
          tier: "small",
          name: "One Slot",
          oracle_mode: "admin",
          initial_price_e6: "1000000",
        }),
      }),
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const txs = (JSON.parse(text) as { unsigned_txs: string[] }).unsigned_txs.map((e) => Transaction.from(Buffer.from(e, "base64")));
    const ixs = txs.flatMap((t) => t.instructions);

    // 1. the market account's length (createAccountWithSeed: the slab, the LP portfolio and the matcher ctx; only the slab is a market size)
    const slabCreate = ixs
      .filter((i) => i.programId.equals(SystemProgram.programId) && i.data.readUInt32LE(0) === 3)
      .map((i) => SystemInstruction.decodeCreateWithSeed(i))
      .filter((c) => assetSlotsForSlabLen(c.space) !== null);
    expect(slabCreate).toHaveLength(1);
    const space = slabCreate[0].space;
    expect(space).toBe(ONE_SLOT_LEN());
    expect(slabCreate[0].lamports).toBe(rent(ONE_SLOT_LEN()));

    // 2. InitMarket's maxPortfolioAssets
    const init = ixs.find((i) => i.data.length === 219 && i.data[0] === IX_TAG.InitMarket)!;
    const slots = decodeInitMarketData(init.data)!.maxPortfolioAssets;
    expect(slots).toBe(1);
    expect(marketLen(slots)).toBe(space);

    // 3. SetMatcherConfig's frontier = slots + 1: byte-equal to the encoder at 2, different from the old 15
    const smc = ixs.find((i) => i.data[0] === IX_TAG.SetMatcherConfig)!;
    const enc = (frontier: bigint) =>
      Buffer.from(encodeSetMatcherConfig({ portfolioId: 1n, expectedSequence: 0n, assetGenerationFrontier: frontier, enabled: 1, tradeFeeCapBps: 10_000, expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT }));
    expect(Buffer.from(smc.data).equals(enc(initialAssetGenerationFrontier(slots)))).toBe(true);
    expect(Buffer.from(smc.data).equals(enc(15n))).toBe(false); // NEGATIVE CONTROL: the pre-change literal is gone
  });

  it("source guard: no literal 14 / 15n is left in the route", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("app/api/mobile/create-market/route.ts", "utf8");
    expect(route).not.toMatch(/v17MarketAccountLen\(14\)|maxPortfolioAssets:\s*14|assetGenerationFrontier:\s*15n/);
    expect(route).toContain("v17MarketAccountLen(assetSlots)");
    expect(route).toContain("maxPortfolioAssets: assetSlots");
    expect(route).toContain("initialAssetGenerationFrontier(assetSlots)");
  });
});
