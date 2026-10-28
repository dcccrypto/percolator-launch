/**
 * Product review 2026-10-28 (S-7 / S-8 / D-2 / D-3 / D-10): on v2.2 the stake copy must match the P3 loss order (creator stake and
 * Earn ahead of insurance), stake v5 (no admin flush) and decision FC-B1 (fee-only stakers earn nothing while the market runs).
 * Flag off keeps the v2.1 lines unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { STAKE_COPY, STAKE_COPY_V22, lossOrderLead, stakeCopy, stakeCoverageCopy, type StakeCopyShape } from "@/lib/stake-copy";
import { V22_COPY } from "@/lib/v22/copy";

afterEach(() => __setDevnetV22ForTest(null));

const allText = (c: StakeCopyShape) =>
  [c.sidebar, c.backStep, c.risk.lead, c.risk.leadTip, c.risk.flush, c.risk.flushTip, c.risk.tail, c.waterfallStakeNote, c.waterfallStakeTip].join(" ");

describe("stake copy, v2.2", () => {
  it("flag off: the v2.1 lines are unchanged", () => {
    __setDevnetV22ForTest(false);
    expect(stakeCopy()).toBe(STAKE_COPY);
    expect(lossOrderLead()).toMatch(/position margin first, then the insurance fund/);
    expect(stakeCoverageCopy().title).toBe("If the pool admin moves stake into insurance");
  });
  it("flag on: no 'covers losses first', no admin flush, no 'share of every trading fee'", () => {
    __setDevnetV22ForTest(true);
    const t = allText(stakeCopy());
    expect(stakeCopy()).toBe(STAKE_COPY_V22);
    expect(t).not.toMatch(/losses first/i);
    expect(t).not.toMatch(/admin moves|admin flush transfers/i);
    expect(t).not.toMatch(/share of every trading fee/i);
    expect(t).toMatch(/fee-only stakers earn nothing while the market runs/i);
    for (const it of stakeCoverageCopy().items) expect(it.description).not.toMatch(/admin flush|before it reaches the market's liquidity and Earn/);
  });
  it("flag on: the trade page loss order agrees with the Earn page (creator stake and Earn before insurance)", () => {
    __setDevnetV22ForTest(true);
    expect(lossOrderLead()).toMatch(/creator's stake and Earn deposits first; insurance can step in only once they're used up/);
    expect(V22_COPY.earnPage.insuranceOrder).toMatch(/creator's stake and Earn deposits first/);
    expect(lossOrderLead()).not.toMatch(/then the insurance fund, then the market's liquidity/);
  });
  it("same keys on both builds (callers swap without a shape change)", () => {
    expect(Object.keys(STAKE_COPY_V22).sort()).toEqual(Object.keys(STAKE_COPY).sort());
    expect(Object.keys(STAKE_COPY_V22.risk).sort()).toEqual(Object.keys(STAKE_COPY.risk).sort());
  });
});
