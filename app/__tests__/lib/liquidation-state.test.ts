/**
 * A position with no mark price rendered as "100% away from liquidation", i.e.
 * maximally safe.
 *
 * `computeLiquidationDistancePct` returns its `fallbackDistancePct = 100` for
 * three different situations — no position, no mark, and no liquidation price —
 * and `getLiquidationSeverity(100)` is "safe". That is the failure #2412 was
 * fixed to prevent ("an absent risk signal is not evidence of safety"), but its
 * guard is `!Number.isFinite(distancePct)`, and a finite 100 walks straight
 * past it without ever being NaN.
 *
 * See lib/liquidation-state.ts.
 */

import { describe, expect, it } from "vitest";
import {
  classifyLiquidation,
  unliquidatableCollateralThreshold,
} from "@/lib/liquidation-state";
import {
  getLiquidationSeverity,
  getLiquidationSeverityForState,
} from "@/hooks/usePortfolio";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";
import { computeLiqPrice } from "@/lib/trading";

const E6 = 1_000_000n;
const LONG = 200n * E6;
const MARK = 1n * E6;
const LIQ = 524_000n; // ~48% below a $1 entry, a real liq price

describe("an absent risk signal must not read as safe", () => {
  it("no mark price is unknown, not safe", () => {
    // THE BUG, pinned: the old helper answers 100 here, which maps to "safe".
    expect(computeLiquidationDistancePct(LONG, 0n, LIQ)).toBe(100);
    expect(getLiquidationSeverity(100)).toBe("safe");

    const state = classifyLiquidation(LONG, 0n, LIQ, true);
    expect(state).toEqual({ kind: "unknown", reason: "no-mark" });
  });

  it("an unresolved entry is unknown, not safe", () => {
    // liqPrice is 0n here for the same reason it is 0n when the position is
    // genuinely unliquidatable — only the resolved entry tells them apart.
    expect(classifyLiquidation(LONG, MARK, 0n, false)).toEqual({
      kind: "unknown",
      reason: "no-entry",
    });
  });

  it("collateral covering the position is unliquidatable, and says so", () => {
    // Truthful, and distinct from "unknown": cross-margin capital exceeding
    // the notional means no price liquidates this position.
    expect(classifyLiquidation(LONG, MARK, 0n, true)).toEqual({
      kind: "unliquidatable",
    });
  });
});

describe("a real liquidation price still ranks normally", () => {
  it("CONTROL: computes the same distance as the existing helper", () => {
    // Load-bearing. Without it, "treat 0 as unknown" could be implemented as
    // "return unknown for everything", which would suppress every genuine
    // warning — the exact direction #2412 says must never fail.
    const state = classifyLiquidation(LONG, MARK, LIQ, true);
    expect(state.kind).toBe("liquidatable");
    if (state.kind !== "liquidatable") throw new Error("unreachable");
    expect(state.distancePct).toBeCloseTo(
      computeLiquidationDistancePct(LONG, MARK, LIQ),
      2,
    );
    expect(getLiquidationSeverity(state.distancePct)).toBe("safe");
  });

  it("CONTROL: a position past its liquidation price is distance 0", () => {
    // Direction-aware: a short whose mark crossed ABOVE its liq is at 0, not
    // "far away". Same semantics the existing helper already has.
    expect(classifyLiquidation(LONG, 500_000n, LIQ, true)).toEqual({
      kind: "liquidatable",
      distancePct: 0,
    });
    const SHORT = -200n * E6;
    expect(classifyLiquidation(SHORT, 2n * E6, LIQ, true)).toEqual({
      kind: "liquidatable",
      distancePct: 0,
    });
  });

  it("CONTROL: a near-liquidation long still ranks as danger", () => {
    const nearLiq = 950_000n; // mark $1.00, liq $0.95 -> 5% away
    const state = classifyLiquidation(LONG, MARK, nearLiq, true);
    if (state.kind !== "liquidatable") throw new Error("expected liquidatable");
    expect(state.distancePct).toBeCloseTo(5, 1);
    expect(getLiquidationSeverity(state.distancePct)).toBe("danger");
  });

  it("a flat position is unknown, not safe", () => {
    expect(classifyLiquidation(0n, MARK, LIQ, true)).toEqual({
      kind: "unknown",
      reason: "no-position",
    });
  });
});

describe("the collateral threshold the UI can explain", () => {
  it("is the notional at entry, at every maintenance margin (engine model, #2987)", () => {
    // $200 notional -> $200 of collateral removes the liq price: the engine never
    // liquidates a long whose equity covers its notional. This is the number that makes
    // the behaviour explicable rather than arbitrary.
    expect(unliquidatableCollateralThreshold(LONG, MARK, 500n)).toBe(200n * E6);
    expect(unliquidatableCollateralThreshold(LONG, MARK, 0n)).toBe(200n * E6);
    // ...and it is exactly where the shipped liquidation price disappears.
    expect(computeLiqPrice(MARK, 200n * E6, LONG, 500n)).toBe(0n);
    expect(computeLiqPrice(MARK, 200n * E6 - 1n, LONG, 500n)).toBeGreaterThan(0n);
  });

  it("declines when there is nothing to compute from", () => {
    expect(unliquidatableCollateralThreshold(0n, MARK, 500n)).toBe(0n);
    expect(unliquidatableCollateralThreshold(LONG, 0n, 500n)).toBe(0n);
    // shorts have no upper-bound clamp — the threshold is a long-side concept
    expect(unliquidatableCollateralThreshold(-LONG, MARK, 500n)).toBe(0n);
  });
});

describe("severity must come from the state, not the percentage", () => {
  it("an unknown state is NOT safe", () => {
    // The whole point. Classifying correctly is useless if the severity
    // mapping still answers "safe" — and a mutant that returns "safe" for
    // every unknown passed the rest of this file.
    expect(getLiquidationSeverityForState({ kind: "unknown", reason: "no-mark" })).toBe("danger");
    expect(getLiquidationSeverityForState({ kind: "unknown", reason: "no-entry" })).toBe("danger");
  });

  it("collateral covering the position IS safe", () => {
    // CONTROL. Failing everything to "danger" would bury the real warnings
    // under a permanent one — #2412's asymmetry argument cuts both ways.
    expect(getLiquidationSeverityForState({ kind: "unliquidatable" })).toBe("safe");
  });

  it("a flat position is safe, not a warning", () => {
    // CONTROL. No position means no liquidation risk; treating it as unknown
    // would flag every idle portfolio row as dangerous.
    expect(getLiquidationSeverityForState({ kind: "unknown", reason: "no-position" })).toBe("safe");
  });

  it("CONTROL: a real distance still maps exactly as before", () => {
    // The state path must not change how genuine distances are ranked.
    for (const pct of [0, 5, 10, 10.1, 30, 30.1, 100]) {
      expect(
        getLiquidationSeverityForState({ kind: "liquidatable", distancePct: pct }),
        `distancePct=${pct}`,
      ).toBe(getLiquidationSeverity(pct));
    }
  });

  it("end to end: no mark price no longer reads as safe", () => {
    const state = classifyLiquidation(LONG, 0n, LIQ, true);
    expect(getLiquidationSeverityForState(state)).toBe("danger");
    // ...whereas the percentage path still says safe, which is the bug.
    expect(getLiquidationSeverity(computeLiquidationDistancePct(LONG, 0n, LIQ))).toBe("safe");
  });
});
