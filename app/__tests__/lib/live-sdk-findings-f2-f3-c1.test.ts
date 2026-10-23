// @vitest-environment node
/**
 * Live devnet SDK test findings (2026-10-01, ledger live-devnet-sdk-tests-2026-10-01.md):
 *  F-2 / M-1: the wrapper allows ONE leg per asset in a BatchTradeCpi (a second same-asset leg is
 *       Custom 9), and its max_slippage_atoms / max_fee_atoms are hard caps (0/0 = Custom 9).
 *  F-3: LP discovery read a "matcher enabled" bit from the Earn registry's feeShareBps.
 *  C-1: new markets' Earn + stake cooldowns are the 150-slot relaunch floor.
 *  M-1 follow-up: new LPs launch with skew 0; the creator can drop it ("Improve pricing").
 * Devnet simulation of the same builders (9EPm + 8WC8): split open/close as 2 TradeCpi OK,
 * 1-leg batch with batchTradeCaps OK vs 0/0 Custom 9, Improve pricing OK as owner / 8005 otherwise.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN } from "@percolatorct/sdk";
import { matcherPortfolio } from "../helpers/v22-fixtures";
import { buildTradeCpiIx, buildTradeIxs, batchTradeCaps } from "@/lib/trade-ix";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { matcherCtxOfPortfolio } from "@/lib/limits/lp-discovery";
import { EARN_VAULT_COOLDOWN_SLOTS, STAKE_POOL_COOLDOWN_SLOTS } from "@/lib/earn-vault-seed";
import { buildInitMatcherCtxArgs, deriveMatcherLimits } from "@/lib/matcher-params";
import { fixPricingEligible, skewOffSetParams, buildFixPricingIx } from "@/lib/fix-pricing";
import type { MatcherCtxView } from "@/lib/limits/decode";

const TAG_TRADE_CPI = 10;
const TAG_BATCH_TRADE_CPI = 67;
const pk = () => Keypair.generate().publicKey;

const tradeParams = (legs: bigint[]) => ({
  programId: pk(), signer: pk(), market: pk(), accountA: pk(), accountB: pk(),
  matcherProg: pk(), matcherCtx: pk(), matcherDelegate: pk(),
  takerId: { portfolioId: 2n, positionEpoch: 0n },
  lpId: { portfolioId: 1n, positionEpoch: 0n, matcherSequence: 3n },
  marketId: 1n, legs, size: legs.reduce((a, b) => a + b, 0n), limitPriceE6: 3_780n, marketTradeFeeBps: 5n,
});

describe("F-2: an oversize order is never a same-asset BatchTradeCpi", () => {
  it("2 legs => 2 single-leg TradeCpi (tag 10), no tag 67", () => {
    const ixs = buildTradeIxs(tradeParams([2_777_777_777n, 2_777_777_778n]));
    expect(ixs).toHaveLength(2);
    expect(ixs.map((ix) => ix.data[0])).toEqual([TAG_TRADE_CPI, TAG_TRADE_CPI]);
  });
  it("buildTradeCpiIx never emits a BatchTradeCpi for a split (base did: Custom 9 on-chain)", () => {
    let data: Uint8Array | null = null;
    try {
      data = buildTradeCpiIx(tradeParams([1n, 1n])).data;
    } catch {
      data = null;
    }
    expect(data?.[0]).not.toBe(TAG_BATCH_TRADE_CPI);
  });
  it("one leg => one TradeCpi", () => {
    expect(buildTradeIxs(tradeParams([5n])).map((ix) => ix.data[0])).toEqual([TAG_TRADE_CPI]);
  });
});

describe("F-2: batch caps are real, never 0/0", () => {
  it("caps for a $20 long at 3600 with a 5% limit and 5 bps fee: slippage = limit budget, fee with headroom", () => {
    const q = (20n * 10n ** 12n) / 3600n;
    const caps = batchTradeCaps({ legs: [{ sizeQ: q, limitPriceE6: 3780n, markE6: 3600n }], feeBps: 5n });
    expect(caps.maxSlippageAtoms).toBe(1_000_001n);
    // Fee priced at the worst price (limit 3780 +5%), not the mark: one tick of drift must fit.
    expect(caps.maxFeeAtoms).toBe(11_026n);
    const atMarkFee = 10_000n; // ceil($20 * 5 bps) in atoms
    expect(caps.maxFeeAtoms - atMarkFee).toBeGreaterThan(1_000n);
  });
  it("no limit => the fallback slippage budget, still non-zero", () => {
    const caps = batchTradeCaps({ legs: [{ sizeQ: -1_000_000n, limitPriceE6: 0n, markE6: 2_000_000n }], feeBps: 0n });
    expect(caps.maxSlippageAtoms).toBe(100_001n); // 5% of $2 notional, +1
    expect(caps.maxFeeAtoms).toBe(1n);
  });
});

describe("F-3: only a full portfolio can be the LP", () => {
  const control = (buf: Buffer, enabled: boolean) => {
    const off = buf.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
    buf.writeBigUInt64LE(enabled ? 1n : 0n, off + 96);
    return buf;
  };
  it("the Earn registry (176 B, kind 5) with an ODD feeShareBps is not an LP", () => {
    const registry = Buffer.alloc(176);
    registry[10] = 5;
    // feeShareBps = 1001 lands where a portfolio's control word would be read
    const off = registry.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
    registry.writeBigUInt64LE(1001n | (8000n << 16n), off + 96);
    expect(isLpPortfolio(registry)).toBe(false);
    expect(matcherCtxOfPortfolio(registry)).toBeNull();
  });
  // A full portfolio of the ACTIVE layout (9,563 B v18 flag off; a captured 10,603 B VERSION-19 portfolio flag on).
  it("a full portfolio (kind 2) with the enabled bit IS the LP", () => {
    const pf = matcherPortfolio(true);
    expect(pf[10]).toBe(2);
    expect(isLpPortfolio(pf)).toBe(true);
  });
  it("a full-length account of another kind is not", () => {
    const other = matcherPortfolio(true);
    other[10] = 3;
    expect(isLpPortfolio(other)).toBe(false);
  });
});

describe("C-1 + skew: new-market parameters", () => {
  it("Earn and stake cooldowns are the 150-slot relaunch floor", () => {
    expect(EARN_VAULT_COOLDOWN_SLOTS).toBe(150n);
    expect(STAKE_POOL_COOLDOWN_SLOTS).toBe(150n);
  });
  it("new LPs launch with skew 0 (matcher units bug), other params unchanged", () => {
    const limits = deriveMatcherLimits(10, 1_000_000_000n, 3_600n);
    const args = buildInitMatcherCtxArgs(5, limits);
    expect(args.skewSpreadMultBps).toBe(0);
    expect(args.maxFillAbs).toBe(limits.maxFillAbs);
  });
});

describe("Improve pricing (matcher tag 5 SetParams, skew 0)", () => {
  const ctx: MatcherCtxView = {
    kind: 1, tradingFeeBps: 5, baseSpreadBps: 50, maxTotalBps: 200, impactKBps: 200,
    liquidityNotionalE6: 10_000_000_000n, maxFillAbs: 318_748_188_930n, inventoryBase: 0n,
    maxInventoryAbs: 1_274_992_755_722n, feeToInsuranceBps: 0, skewSpreadMultBps: 1, v2: null,
  };
  const owner = pk();
  it("only the LP owner, only while skew is on, only for a v1 context", () => {
    expect(fixPricingEligible(ctx, owner, owner)).toBe(true);
    expect(fixPricingEligible(ctx, pk(), owner)).toBe(false);
    expect(fixPricingEligible({ ...ctx, skewSpreadMultBps: 0 }, owner, owner)).toBe(false);
    expect(fixPricingEligible({ ...ctx, v2: {} as NonNullable<MatcherCtxView["v2"]> }, owner, owner)).toBe(false);
    expect(fixPricingEligible(ctx, null, owner)).toBe(false);
  });
  it("restates every parameter with only skew zeroed", () => {
    const p = skewOffSetParams(ctx);
    expect(p).toMatchObject({ kind: 1, tradingFeeBps: 5, baseSpreadBps: 50, maxTotalBps: 200, impactKBps: 200, liquidityNotionalE6: ctx.liquidityNotionalE6, maxFillAbs: ctx.maxFillAbs, maxInventoryAbs: ctx.maxInventoryAbs, feeToInsuranceBps: 0, skewSpreadMultBps: 0, enableV2: false });
  });
  it("tag 5, owner-proof, op SetParams; owner signs, ctx writable", () => {
    const matcherCtx = pk();
    const ix = buildFixPricingIx({ wrapperProgramId: pk(), matcherProgramId: pk(), market: pk(), lpPortfolio: pk(), lpOwner: owner, matcherCtx, ctx });
    expect([ix.data[0], ix.data[1], ix.data[99]]).toEqual([5, 1, 1]);
    expect(ix.keys.map((k) => [k.pubkey.equals(owner) || k.pubkey.equals(matcherCtx), k.isSigner, k.isWritable])).toEqual([[true, true, false], [true, false, true]]);
  });
});

void PublicKey;
