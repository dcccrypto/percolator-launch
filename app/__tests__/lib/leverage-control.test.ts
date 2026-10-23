/**
 * GH#2628 — the order ticket's leverage control.
 *
 * Three defects in fifteen inline lines of JSX:
 *
 *  1. the typed input ran through Math.round, so "2.5" became 3 — a 20%
 *     leverage increase the trader did not ask for, always in the riskier
 *     direction because Math.round breaks ties upward;
 *  2. the slider stepped by 1, so no fractional value was reachable;
 *  3. the snap-to-preset reduce was seeded with `raw`, so |best - raw| started
 *     at 0, no candidate could beat it, and the snapping never fired.
 *
 * The first version of these tests RE-IMPLEMENTED the control, because inline
 * JSX cannot be imported — the "mirrors page logic" pattern that let three
 * defects sit there unnoticed. The logic is extracted now, so these import the
 * real thing and the anti-drift source scan that PoC needed is gone.
 */

import { describe, expect, it } from "vitest";
import {
  availableLeverage,
  quantizeTypedLeverage,
  clampSliderLeverage,
  nextLeverageInputState,
  leverageToPct,
  pctToLeverage,
  LEVERAGE_STEP,
} from "@/lib/leverage-control";
import { formatLeverageValue } from "@/lib/leverage-display";

describe("a typed leverage is never silently raised", () => {
  it("keeps the half-steps a trader actually types", () => {
    for (const typed of [2.5, 3.5, 4.5, 6.5, 7.5]) {
      expect(quantizeTypedLeverage(typed, 20)).toBe(typed);
    }
  });

  it("rounds DOWN between representable steps, never up", () => {
    // Math.round turned every one of these into a leverage increase. The
    // direction matters: more leverage than requested is a closer liquidation.
    expect(quantizeTypedLeverage(4.567, 20)).toBe(4.56);
    expect(quantizeTypedLeverage(4.999, 20)).toBe(4.99);
    // The specific regression: 2.5 must not become 3.
    expect(quantizeTypedLeverage(2.5, 20)).not.toBe(3);
  });

  it("still clamps to the market's range", () => {
    expect(quantizeTypedLeverage(99, 10)).toBe(10);
    expect(quantizeTypedLeverage(0, 10)).toBe(1);
    expect(quantizeTypedLeverage(-5, 10)).toBe(1);
  });

  it("reaches a market's own fractional maximum on purpose, not by accident", () => {
    // On a 4.5x market this used to work only because Math.round(4.5) = 5 and
    // the clamp pulled it back. Typing 3.5 there became 4.
    expect(quantizeTypedLeverage(4.5, 4.5)).toBe(4.5);
    expect(quantizeTypedLeverage(3.5, 4.5)).toBe(3.5);
  });

  it("returns the minimum for non-finite input rather than propagating NaN", () => {
    expect(quantizeTypedLeverage(Number.NaN, 10)).toBe(1);
    expect(quantizeTypedLeverage(Infinity, 10)).toBe(1);
  });

  it("CONTROL: it tracks its input rather than returning a constant", () => {
    expect(quantizeTypedLeverage(3, 10)).toBe(3);
    expect(quantizeTypedLeverage(7, 10)).toBe(7);
    expect(quantizeTypedLeverage(3, 10)).not.toBe(quantizeTypedLeverage(4, 10));
  });
});

describe("the slider can express the leverages a market can be created at", () => {
  it("steps at the same granularity markets are created with", () => {
    // GH#2621 creates markets in 0.5 steps; a trader should be able to select
    // any of them.
    expect(LEVERAGE_STEP).toBe(0.5);
  });

  it("reaches 6.5 on a 10x market, which was previously unreachable by any means", () => {
    const reachable: number[] = [];
    for (let raw = 1; raw <= 10; raw += LEVERAGE_STEP) {
      reachable.push(clampSliderLeverage(raw, 10));
    }
    expect(reachable).toContain(6.5);
    expect(reachable).toContain(2.5);
    expect(reachable[reachable.length - 1]).toBe(10);
  });

  it("no longer overrides a drag by snapping it to a preset", () => {
    // The old code tried to snap and never did. Repairing it would have been
    // worse than removing it: the computed radius on a 10x market was 1, which
    // at a 0.5 step swallows every half-step within a whole leverage of a
    // preset — 4.5 and 5.5 would both jump to 5 and the finer step would be
    // decorative.
    expect(clampSliderLeverage(4.5, 10)).toBe(4.5);
    expect(clampSliderLeverage(5.5, 10)).toBe(5.5);
    expect(clampSliderLeverage(4, 10)).toBe(4);
  });

  it("clamps to the market's range", () => {
    expect(clampSliderLeverage(99, 7.5)).toBe(7.5);
    expect(clampSliderLeverage(0, 7.5)).toBe(1);
    expect(clampSliderLeverage(Number.NaN, 7.5)).toBe(1);
  });
});

// N3: the thumb and labels sit on the preset index scale; a pointer must map back through it.
describe("the slider track maps a pointer to the leverage drawn under it", () => {
  it("each preset's position maps back to that preset", () => {
    for (const max of [10, 20, 6.66, 4.5]) {
      const presets = availableLeverage(max);
      for (const p of presets) expect(pctToLeverage(leverageToPct(p, presets) / 100, presets, max)).toBe(p);
    }
  });

  it("the 5x stop is 5x, not the linear 7x (10x market) or 10.5x (20x market)", () => {
    expect(pctToLeverage(2 / 3, [1, 3, 5, 10], 10)).toBe(5);
    expect(pctToLeverage(0.5, [1, 3, 5, 10, 20], 20)).toBe(5);
  });

  it("between presets the pointer lands on the half-step grid", () => {
    // Halfway between the 5x and 10x stops of a 10x market.
    expect(pctToLeverage(5 / 6, [1, 3, 5, 10], 10)).toBe(7.5);
    expect(pctToLeverage(0.1, [1, 3, 5, 10], 10)).toBe(1.5);
  });

  it("CONTROL: the ends are 1x and the max, and junk is 1x", () => {
    expect(pctToLeverage(0, [1, 3, 5, 10], 10)).toBe(1);
    expect(pctToLeverage(1.4, [1, 3, 5, 6.66], 6.66)).toBe(6.66);
    expect(pctToLeverage(Number.NaN, [1, 3, 5, 10], 10)).toBe(1);
  });
});

describe("the presets still include the market's own maximum", () => {
  it("offers the standard rungs below the max, plus the max itself", () => {
    expect(availableLeverage(10)).toEqual([1, 3, 5, 10]);
    expect(availableLeverage(7.5)).toEqual([1, 3, 5, 7.5]);
    expect(availableLeverage(4.5)).toEqual([1, 3, 4.5]);
  });

  it("does not duplicate the max when it is already a rung", () => {
    expect(availableLeverage(5)).toEqual([1, 3, 5]);
  });

  it("an off-grid max is reachable here even though the slider cannot step to it", () => {
    // 1500 bps is 6.66x — Math.floor((10000/1500)*100)/100. The first version of
    // this test asserted 6.67, a value the product cannot generate.
    expect(Math.floor((10000 / 1500) * 100) / 100).toBe(6.66);
    expect(availableLeverage(6.66)).toEqual([1, 3, 5, 6.66]);
    expect(6.66 % LEVERAGE_STEP).not.toBe(0);
  });
});

// The wiring used to be pinned here by a source scan over OrderTicket.tsx.
// It is gone: __tests__/components/trade/OrderTicket.leverage-input.test.tsx
// renders the real component and kills every call-site mutant the scan missed —
// including a local `const LEVERAGE_STEP = 1` shadowing the import, and a
// working snap re-added one line from the helper below. The scan also carried a
// latent false failure: it stripped comments by cutting each line at the first
// "//", so the first URL added to one of those lines would have broken CI.

describe("typing a decimal into the leverage box", () => {
  /**
   * The real defect, and the one the reported symptom hid.
   *
   *   reported:  typing 4.5 applies 5      (Math.round, +11%)
   *   actual:    typing 4.5 applies MAX    (the decimal point is destroyed)
   *
   * The ticket set the text from the input and then immediately overwrote it
   * with formatLeverageValue(parsed). parseFloat("4.") is 4, so the keystroke
   * that typed the dot rewrote the box as "4" and erased it; the next digit
   * appended to "4" giving "45", which the clamp pulled to the market maximum.
   */
  const typeChars = (chars: string, maxLeverage: number) => {
    let text = "";
    let leverage: number | null = null;
    const trace: string[] = [];
    for (const ch of chars) {
      const next = nextLeverageInputState(text + ch, maxLeverage);
      text = next.text;
      if (next.leverage !== null) leverage = next.leverage;
      trace.push(`${ch}->"${text}"`);
    }
    return { text, leverage, trace };
  };

  it("typing 2.5 on a 20x market yields 2.5, not 20", () => {
    const { text, leverage } = typeChars("2.5", 20);
    expect(text).toBe("2.5");
    expect(leverage).toBe(2.5);
    // The old behaviour, spelled out: 8x what was asked for.
    expect(leverage).not.toBe(20);
  });

  it("the intermediate '2.' survives instead of collapsing to '2'", () => {
    // This single keystroke is the whole bug.
    expect(nextLeverageInputState("2.", 20).text).toBe("2.");
    // And it applies nothing yet — "2." is not a leverage the trader chose.
    expect(nextLeverageInputState("2.", 20).leverage).toBe(2);
  });

  it("holds while the text is not yet a number", () => {
    expect(nextLeverageInputState("", 20)).toEqual({ text: "", leverage: null });
    expect(nextLeverageInputState(".", 20)).toEqual({ text: ".", leverage: null });
  });

  it("still sanitises, clamps and quantises", () => {
    expect(nextLeverageInputState("4..5", 20).text).toBe("4.5");
    expect(nextLeverageInputState("a4.5b", 20).text).toBe("4.5");
    expect(nextLeverageInputState("99", 10).leverage).toBe(10);
    expect(nextLeverageInputState("4.567", 20).leverage).toBe(4.56);
  });

  it("CONTROL: typing an integer is unaffected", () => {
    const { text, leverage } = typeChars("45", 200);
    expect(text).toBe("45");
    expect(leverage).toBe(45);
  });
});

describe("the quantiser is precision-safe, and the formatter can show what it produces", () => {
  it("does not lose a cent to binary floating point", () => {
    // A bare Math.floor(parsed * 100) / 100 drops a cent on 134 of the 1901
    // two-decimal values between 1 and 20, because multiplying by 100 is not
    // exact in binary. lib/notional.ts documents this exact hazard; the first
    // version of this quantiser walked straight back into it.
    expect(quantizeTypedLeverage(1.15, 20)).toBe(1.15);
    expect(quantizeTypedLeverage(2.3, 20)).toBe(2.3);
    expect(quantizeTypedLeverage(2.05, 20)).toBe(2.05);
    // The unguarded form, for contrast — this is what those returned.
    expect(Math.floor(1.15 * 100) / 100).toBe(1.14);
  });

  it("sweeps every 2dp value in range without drift", () => {
    let wrong = 0;
    for (let i = 100; i <= 2000; i++) {
      const v = i / 100;
      if (quantizeTypedLeverage(v, 20) !== v) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it("the formatter can display the 2dp values the quantiser produces", () => {
    // toFixed(1) could not: a 6.66x market's own preset button read "6.7x"
    // while applying 6.66, and a typed 4.56 displayed as "4.6". A control must
    // not apply a number it cannot show — that is the defect this issue is
    // about, one layer up.
    expect(formatLeverageValue(6.66)).toBe("6.66");
    expect(formatLeverageValue(4.56)).toBe("4.56");
    expect(formatLeverageValue(9.49)).toBe("9.49");
    // CONTROL: the common cases stay short.
    expect(formatLeverageValue(4)).toBe("4");
    expect(formatLeverageValue(4.5)).toBe("4.5");
  });
});
