// @vitest-environment node
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { buildExitPlan, floorFor, formatAtoms, quoteLine, showDipNote, type ExitContext } from "@/lib/v22/earn-exit";
import { REDEMPTION_REFRESH_MAX_V22, REDEMPTION_REFRESH_WEIGHT_BUDGET_V22, refreshWeightV22 } from "@/lib/v22/sdk";

const k = () => Keypair.generate().publicKey;
const ctx = (over: Partial<ExitContext> = {}): ExitContext => ({
  market: { programId: new PublicKey(resolveDevnetProgramIds().wrapper), market: k(), registryDomain: 0 },
  redeemer: k(),
  redeemerLpAta: k(),
  redeemerDest: k(),
  vaultToken: k(),
  sourceDomain: 0,
  shares: 1_000n,
  ...over,
});
const stale = (n: number, legs = 1) => Array.from({ length: n }, () => ({ key: k(), legs }));

describe("v22 earn exit planner", () => {
  it("floor = quote minus exactly 5 bps (floored), on BOTH the 76 trailer and the 77 wire", () => {
    const plan = buildExitPlan(ctx(), []);
    const f = plan.finalize(1_000_000n);
    expect(f.minPayoutAtoms).toBe(999_500n);
    expect(floorFor(1_000_000n)).toBe(999_500n);
    // 76: [76, shares u128, min u64, keeper_ok u8]; 77: [77, domain u16, min u64, n_refresh u8]
    expect(f.requestIx.data[0]).toBe(76);
    expect(f.requestIx.data.readBigUInt64LE(1 + 16)).toBe(999_500n);
    expect(f.executeIx.data[0]).toBe(77);
    expect(f.executeIx.data.readBigUInt64LE(3)).toBe(999_500n);
  });

  it("selection is at most 8 and within the weight budget 34; the rest is deferred", () => {
    const plan = buildExitPlan(ctx(), stale(12, 1));
    expect(plan.refreshSelected.length).toBeLessThanOrEqual(REDEMPTION_REFRESH_MAX_V22);
    expect(plan.refreshSelected.length).toBe(8);
    expect(plan.refreshWeight).toBeLessThanOrEqual(REDEMPTION_REFRESH_WEIGHT_BUDGET_V22);
    expect(plan.refreshDeferred.length).toBe(4);
    const heavy = buildExitPlan(ctx(), stale(4, 14)); // weight 17 each -> two fit
    expect(heavy.refreshSelected.length).toBe(Math.floor(REDEMPTION_REFRESH_WEIGHT_BUDGET_V22 / refreshWeightV22(14)));
  });

  it("refreshing exit uses the 1.3M budget; a loss-current book the smaller one", () => {
    expect(buildExitPlan(ctx(), stale(2)).computeUnits).toBe(1_300_000);
    expect(buildExitPlan(ctx(), []).computeUnits).toBeLessThan(1_300_000);
  });

  it("a bound vault never carries refresh accounts", () => {
    const plan = buildExitPlan(ctx({ boundLpPortfolio: k() }), stale(5));
    expect(plan.refreshSelected).toEqual([]);
    expect(plan.finalize(10_000n).executeIx.keys.length).toBe(15); // 13 base + vault_lp_state + vault LP, no refresh
  });

  it("the simulation uses a 1-atom floor, the final uses the floor", () => {
    const plan = buildExitPlan(ctx(), stale(1));
    expect(plan.simulationIx.data.readBigUInt64LE(3)).toBe(1n);
    expect(plan.finalize(10_000n).executeIx.data.readBigUInt64LE(3)).toBe(9_995n);
  });

  it("quote copy and dip note", () => {
    expect(formatAtoms(1_234_567_890n, 6)).toBe("1,234.56");
    expect(quoteLine(999_500n, 6, "USDC")).toBe("You'll receive at least 0.99 USDC");
    expect(showDipNote(0)).toBe(false);
    expect(showDipNote(3)).toBe(true);
    expect(new PublicKey(k()).toBase58().length).toBeGreaterThan(30);
  });
});
