/**
 * Council GO1106-UX #2 (LP / Creator / Skeptic): "Every vault row and the rail show TVL '—'. The header reads
 * 'TOTAL VALUE LOCKED $0 — Excludes 6 vaults ... that can't be valued right now'." The v2.2 preview has no
 * NEXT_PUBLIC_LIMITS_P3, and earnPanelPricing returned null for every bound vault without it. On a v2.2 build the
 * program writes the bound byte itself, so Earn prices bound vaults the P3 way there.
 */
import { afterEach, describe, expect, it } from "vitest";
import { earnPanelPricing } from "@/lib/limits/earn";
import { earnP3Enabled } from "@/lib/limits/flags";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ALL_ON, marketLimits } from "./fixtures";

const P3_OFF = { ...ALL_ON, p3: false };
afterEach(() => __setDevnetV22ForTest(null));

describe("earnP3Enabled", () => {
  it("P3 off + v2.2 build: on", () => {
    __setDevnetV22ForTest(true);
    expect(earnP3Enabled(P3_OFF)).toBe(true);
  });
  it("CONTROL P3 off + not v2.2: off (a pre-P3 deployment is unchanged)", () => {
    __setDevnetV22ForTest(false);
    expect(earnP3Enabled(P3_OFF)).toBe(false);
  });
  it("P3 on: on", () => {
    __setDevnetV22ForTest(false);
    expect(earnP3Enabled(ALL_ON)).toBe(true);
  });
});

describe("earnPanelPricing on a v2.2 build without the P3 flag", () => {
  it("prices the bound vault (was null => TVL '—')", () => {
    __setDevnetV22ForTest(true);
    const p = earnPanelPricing(marketLimits({ flags: P3_OFF }), 1_000_000_000n);
    expect(p).not.toBeNull();
    expect(p!.withdrawSeniorValue).not.toBeNull();
  });
  it("CONTROL: not v2.2 and P3 off: still null", () => {
    __setDevnetV22ForTest(false);
    expect(earnPanelPricing(marketLimits({ flags: P3_OFF }), 1_000_000_000n)).toBeNull();
  });
  it("CONTROL: an unbound vault is never priced the P3 way", () => {
    __setDevnetV22ForTest(true);
    const base = marketLimits();
    expect(earnPanelPricing(marketLimits({ flags: P3_OFF, vaultLp: { ...base.vaultLp!, bound: false } }), 1_000_000_000n)).toBeNull();
  });
});
