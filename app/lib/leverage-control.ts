/**
 * The order ticket's leverage control — bounds, quantisation and presets.
 *
 * GH#2628. This lived inline in OrderTicket's JSX, which made it untestable:
 * the only way to assert on it was to re-implement it in a test file and hope
 * the copy stayed in step, which is the pattern that let three defects sit in
 * fifteen lines of it —
 *
 *   1. the typed input ran through Math.round, so "2.5" became 3 — a 20%
 *      leverage increase the trader did not ask for and was not told about,
 *      and always in the riskier direction because Math.round breaks ties
 *      upward;
 *   2. the slider stepped by 1, so no fractional value was reachable by
 *      dragging either;
 *   3. the snap-to-preset reduce was seeded with `raw`, so |best - raw| started
 *      at 0, no candidate could ever beat it, and the snapping never fired.
 *
 * Fractional leverage is not an edge case here: markets are created in 0.5
 * steps (GH#2621), and a market's own maximum is derived to two decimals.
 */
import { sanitizeDecimalInput } from "@/lib/decimal-input";

/** Preset leverages offered as buttons, filtered to what the market allows. */
export const LEVERAGE_SNAP_POINTS = [1, 3, 5, 10, 20];

/**
 * Slider granularity.
 *
 * 0.5 matches the step markets are created at, so MOST leverages a market can
 * be created with are reachable on the slider that trades it. Not all: a
 * market's max round-trips through bps and back, and 6x, 7x and 9.5x come back
 * as 5.99, 6.99 and 9.49 — off the 0.5 grid, so the keyboard can't step to them.
 * The preset button for the max, or the far end of the track, reaches them.
 * (1500 bps is 6.66x here, not 6.67 — the derivation floors at 2dp.)
 */
export const LEVERAGE_STEP = 0.5;

/** Two decimals, matching how a market's max leverage is itself derived. */
const QUANTUM = 100;

/**
 * The preset buttons for a market, always including its own maximum.
 */
export function availableLeverage(maxLeverage: number): number[] {
  const arr = LEVERAGE_SNAP_POINTS.filter((l) => l <= maxLeverage);
  if (arr.length === 0 || arr[arr.length - 1] < maxLeverage) arr.push(maxLeverage);
  return arr;
}

/**
 * A typed leverage, quantised to what the control can represent.
 *
 * Rounds DOWN, not to nearest, so a value between representable steps resolves
 * to the one the trader did not have to ask for twice.
 *
 * On the DIRECTION, because the obvious argument is wrong for this control:
 * "more leverage is a closer liquidation" is true of a margin-first ticket, and
 * this one is size-first. The trader enters a size; margin is derived as
 * notional/leverage and the position size comes back out as margin*leverage, so
 * SIZE — and therefore the liquidation price, which is computed against the
 * account's whole collateral — is invariant to leverage here. What leverage
 * actually moves is how much collateral gets RESERVED. Rounding down reserves
 * more, which is the conservative direction but can trip the `exceedsBalance`
 * gate on an order a rounded-up value would have allowed. Flooring is still the
 * right default (it never silently gives a trader a number they did not type),
 * but it is not the safety property the first version of this comment claimed.
 *
 * Non-finite input returns the minimum rather than throwing or propagating NaN;
 * the caller's `isNaN` guard means this is belt-and-braces, but this function is
 * exported and should not depend on its caller checking first.
 */
export function quantizeTypedLeverage(parsed: number, maxLeverage: number): number {
  if (!Number.isFinite(parsed)) return 1;
  // toFixed(6) before flooring, for the reason lib/notional.ts documents:
  // multiplying by 100 is not exact in binary, so a bare
  // Math.floor(parsed * 100) / 100 drops a cent on 134 of the 1901 two-decimal
  // values between 1 and 20 — 1.15 became 1.14, 2.30 became 2.29.
  const floored = Math.floor(Number((parsed * QUANTUM).toFixed(6))) / QUANTUM;
  return Math.max(1, Math.min(maxLeverage, floored));
}

/**
 * A slider position, clamped to the market's range.
 *
 * Deliberately does NOT snap to the nearest preset. The old code tried to and
 * never did (see defect 3 above); repairing it rather than removing it would
 * have made things worse once the step became fractional, because the computed
 * snap radius on a 10x market is 1 — wide enough to swallow every half-step
 * within a whole leverage of a preset, so 4.5 and 5.5 would both jump to 5 and
 * the fractional step would be decorative. The presets remain one click away as
 * buttons, which is a better way to offer them than silently overriding a drag.
 */
export function clampSliderLeverage(raw: number, maxLeverage: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(maxLeverage, raw));
}

/**
 * Leverage -> % along the slider track. The presets are evenly spaced (index scale), so
 * 1/3/5/10/20 don't bunch up at the left; between two presets the position is linear.
 */
export function leverageToPct(val: number, presets: readonly number[]): number {
  const n = presets.length;
  if (n <= 1) return 0;
  for (let i = 0; i < n - 1; i++) {
    if (val <= presets[i + 1]) {
      const lo = presets[i], hi = presets[i + 1];
      return ((i + (hi > lo ? (val - lo) / (hi - lo) : 0)) / (n - 1)) * 100;
    }
  }
  return 100;
}

/**
 * The inverse of leverageToPct, for a pointer at fraction `frac` (0..1) of the track: the
 * leverage drawn under it, on the LEVERAGE_STEP grid. N3: the native range input mapped the
 * pointer linearly, so on a 10x market a click above the 5x label set 7x.
 */
export function pctToLeverage(frac: number, presets: readonly number[], maxLeverage: number): number {
  const n = presets.length;
  if (!Number.isFinite(frac) || n <= 1) return clampSliderLeverage(presets[0] ?? 1, maxLeverage);
  const f = Math.max(0, Math.min(1, frac));
  // The far end is the max itself, which can sit off the step grid (6.66x).
  if (f === 1) return maxLeverage;
  const pos = f * (n - 1);
  const i = Math.min(Math.floor(pos), n - 2);
  const raw = presets[i] + (pos - i) * (presets[i + 1] - presets[i]);
  return clampSliderLeverage(1 + Math.round((raw - 1) / LEVERAGE_STEP) * LEVERAGE_STEP, maxLeverage);
}

/** What the leverage text box should show, and what value it implies. */
export interface LeverageInputState {
  /** The text to render. Preserves a trailing "." so a decimal can be typed. */
  text: string;
  /** The leverage to apply, or null while the text is not yet a number. */
  leverage: number | null;
}

/**
 * One keystroke in the leverage box.
 *
 * Exists because the bug here was not in any single expression — it was the
 * interaction of two setState calls on one controlled input, which no unit test
 * on the quantiser could see and which the component is too heavy to render
 * (twelve hooks, a slab-state subscription and a live price feed).
 *
 * The ticket used to set the text from the raw input and then immediately
 * overwrite it with `formatLeverageValue(parsed)`. `parseFloat("2.")` is 2, so
 * the keystroke that typed the dot rewrote the box as "2" and erased it; the
 * next digit appended to "2" instead of "2.", producing "25", which the clamp
 * pulled to the market maximum. Typing 2.5 on a 20x market selected 20x.
 *
 * So the text is returned VERBATIM (after sanitising) and never reformatted
 * mid-edit. `leverage` is null while the text is not yet parseable — "", "." and
 * "2." all mean "keep typing", not "apply something".
 */
export function nextLeverageInputState(rawInput: string, maxLeverage: number): LeverageInputState {
  const text = sanitizeDecimalInput(rawInput);
  const parsed = Number.parseFloat(text);
  if (Number.isNaN(parsed)) return { text, leverage: null };
  return { text, leverage: quantizeTypedLeverage(parsed, maxLeverage) };
}
