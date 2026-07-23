/**
 * Fee-split control — client-side validation (sum + floors + defaults).
 *
 * These assert the SAME rules the wrapper enforces on UpdateFeeSplit (tag 86):
 *   - the three shares must sum to exactly 8000 bps (= 10_000 − 2000 protocol),
 *     else on-chain Custom(52) FeeSplitSumInvalid,
 *   - creator ≤ 3600, LP ≥ 3200, insurance ≥ 1200, else Custom(51)
 *     FeeSplitFloorViolation.
 * The wizard blocks Step 3 while validateFeeSplit(...) is non-null, so a passing
 * split here always lands and the creator never eats the cryptic on-chain error.
 */
import { describe, it, expect } from "vitest";
import { validateFeeSplit, FEE_SPLIT } from "@percolatorct/sdk";
import {
  DEFAULT_FEE_SPLIT,
  isDefaultFeeSplit,
} from "@/components/create/FeeSplitControl";

describe("fee-split defaults", () => {
  it("DEFAULT_FEE_SPLIT is the on-chain default (1600 / 4800 / 1600)", () => {
    expect(DEFAULT_FEE_SPLIT).toEqual({
      creatorShareBps: 1600,
      lpShareBps: 4800,
      insuranceShareBps: 1600,
    });
  });

  it("defaults pass validation and sum to FEE_SHARE_TOTAL_BPS (8000)", () => {
    expect(validateFeeSplit(DEFAULT_FEE_SPLIT)).toBeNull();
    const sum =
      DEFAULT_FEE_SPLIT.creatorShareBps +
      DEFAULT_FEE_SPLIT.lpShareBps +
      DEFAULT_FEE_SPLIT.insuranceShareBps;
    expect(sum).toBe(FEE_SPLIT.FEE_SHARE_TOTAL_BPS);
    expect(FEE_SPLIT.FEE_SHARE_TOTAL_BPS).toBe(8000);
    expect(FEE_SPLIT.PROTOCOL_FEE_BPS).toBe(2000);
  });

  it("isDefaultFeeSplit distinguishes defaults from a custom split", () => {
    expect(isDefaultFeeSplit(DEFAULT_FEE_SPLIT)).toBe(true);
    expect(
      isDefaultFeeSplit({ creatorShareBps: 2000, lpShareBps: 4000, insuranceShareBps: 2000 }),
    ).toBe(false);
  });
});

describe("fee-split validation — sum", () => {
  it("accepts a valid non-default split (2000 / 4000 / 2000)", () => {
    expect(
      validateFeeSplit({ creatorShareBps: 2000, lpShareBps: 4000, insuranceShareBps: 2000 }),
    ).toBeNull();
  });

  it("rejects a split that does not sum to 8000", () => {
    // 2000 + 4000 + 1000 = 7000 → sum error
    const reason = validateFeeSplit({
      creatorShareBps: 2000,
      lpShareBps: 4000,
      insuranceShareBps: 1000,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/sum/i);
  });

  it("rejects an over-100% split", () => {
    const reason = validateFeeSplit({
      creatorShareBps: 3600,
      lpShareBps: 4800,
      insuranceShareBps: 1600,
    });
    expect(reason).not.toBeNull();
  });
});

describe("fee-split validation — floors", () => {
  it("rejects creator > 3600 (ceiling)", () => {
    // creator 4000 breaks the ceiling; keep the sum at 8000 by dropping insurance.
    const reason = validateFeeSplit({
      creatorShareBps: 4000,
      lpShareBps: 3200,
      insuranceShareBps: 800,
    });
    expect(reason).not.toBeNull();
    // floor/ceiling wording (creator ceiling OR insurance floor — either is a floor violation)
    expect(reason).toMatch(/creator|insurance|MAX|MIN/i);
  });

  it("rejects LP < 3200 (floor)", () => {
    // LP 3000 below floor, sum still 8000.
    const reason = validateFeeSplit({
      creatorShareBps: 3600,
      lpShareBps: 3000,
      insuranceShareBps: 1400,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/lp|MIN_LP/i);
  });

  it("rejects insurance < 1200 (floor)", () => {
    // insurance 1000 below floor, sum still 8000.
    const reason = validateFeeSplit({
      creatorShareBps: 3600,
      lpShareBps: 3400,
      insuranceShareBps: 1000,
    });
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/insurance|MIN_INSURANCE/i);
  });

  it("accepts exactly-at-the-floor split (3600 / 3200 / 1200)", () => {
    // The three floors are precisely complementary and sum to 8000.
    expect(
      validateFeeSplit({ creatorShareBps: 3600, lpShareBps: 3200, insuranceShareBps: 1200 }),
    ).toBeNull();
  });
});
