// @vitest-environment node
/**
 * App bug 2026-10-29: the hub's bound-vault reader prices with the SAME function as the vault
 * page and the withdraw preview (earnPanelPricing), so the hub, the page and the quote agree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { earnPanelPricing } from "@/lib/limits/earn";
import { boundVaultPricingFromParts, type BoundVaultParts } from "@/lib/limits/earn-bound-pricing";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { ALL_ON, marketLimits } from "./fixtures";

const parts = (backing: bigint, over: Partial<ReturnType<typeof marketLimits>> = {}): BoundVaultParts => {
  const l = marketLimits(over);
  return { engine: l.engine!, vaultLp: l.vaultLp!, lp: l.lp!, vaultState: l.vaultState!, registryShares: l.registryShares!, backingNavAtoms: backing };
};

beforeEach(() => __setLimitsFlagsForTest(ALL_ON));
afterEach(() => __setLimitsFlagsForTest(null));

describe("boundVaultPricingFromParts", () => {
  it("after a loss: identical to the page's earnPanelPricing (the withdraw price)", () => {
    const page = earnPanelPricing(marketLimits(), 700_000_000n)!;
    expect(boundVaultPricingFromParts(parts(700_000_000n))).toEqual({ totalShares: page.totalShares, withdrawSeniorValue: page.withdrawSeniorValue });
    expect(page.withdrawSeniorValue!).toBeLessThan(1_000_000_000n);
  });

  it("settled market: the resolved payout, as on the page", () => {
    const base = marketLimits();
    const resolved = { engine: { ...base.engine!, mode: 1 } };
    const page = earnPanelPricing(marketLimits(resolved), 700_000_000n)!;
    expect(boundVaultPricingFromParts(parts(700_000_000n, resolved))?.withdrawSeniorValue).toBe(page.withdrawSeniorValue);
  });

  it("stale certificate with no simulation: no withdraw price (unknown), not a guess", () => {
    const base = marketLimits();
    const stale = { lp: { ...base.lp!, cert: { ...base.lp!.cert, oracleEpoch: 1n } } };
    expect(boundVaultPricingFromParts(parts(700_000_000n, stale))?.withdrawSeniorValue ?? null).toBeNull();
  });

  it("P3 flag off: null (the app cannot price a bound vault)", () => {
    __setLimitsFlagsForTest({ ...ALL_ON, p3: false });
    expect(boundVaultPricingFromParts(parts(700_000_000n))).toBeNull();
  });
});
