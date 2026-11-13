// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeLiqPrice, resolveEntryPrice } from "@/lib/trading";
import { describeLiqPrice } from "@/lib/liq-price-display";

/**
 * #2673 item 3 — "describeLiqPrice shows a price before consulting
 * hasResolvedEntry, so on the unknown path the Liq cell is fabricated from the
 * mark-as-entry." Checked against the engine's own accounting: it is not.
 *
 * Engine (v16.rs:9382-9437, see resolveEntryPrice's doc): a solvent loser's
 * realized loss is moved OUT of capital and pnl is pushed back to 0. Equity
 * (capital + pnl) is unchanged; only the attribution to an entry is lost. The
 * exact liquidation price depends only on equity:
 *     long:  C + s·(P − E) = m·s·P   ⇒   P* = (E − C/s) / (1 − m)
 * and (E, C) → (mark, C + pnl) leaves E − C/s unchanged. So the unknown path's
 * (entry = mark, crystallized capital) is the same equity reference as the
 * derived path's (entry = mark − pnl/s, original capital).
 */
const MM_BPS = 500n;
const MARK = 81_170_000n; // $81.17, a playground SOL mark
const SIZE = 10_000_000n; // 10 SOL-units (6dp), long
const CAPITAL = 500_000_000n; // $500
const TRUE_ENTRY = 100_000_000n; // opened at $100
const PNL = (SIZE * (MARK - TRUE_ENTRY)) / 1_000_000n; // -$188.30 in atoms

/** Exact equity liquidation price, e6, long. */
function exactLongLiq(entry: bigint, capital: bigint): number {
  const m = Number(MM_BPS) / 10_000;
  return (Number(entry) - (Number(capital) * 1e6) / Number(SIZE)) / (1 - m);
}

describe("#2673.3: the Liq cell on the unknown path is an equity figure, not a fabrication", () => {
  it("before crystallization: derived entry recovers the true entry", () => {
    expect(PNL).toBe(-188_300_000n);
    const r = resolveEntryPrice(SIZE, 0n, PNL, MARK);
    expect(r).toEqual({ entry: TRUE_ENTRY, source: "derived" });
  });

  it("after crystallization (pnl → 0, capital → capital + pnl) the exact liq is unchanged", () => {
    const after = resolveEntryPrice(SIZE, 0n, 0n, MARK);
    expect(after.source).toBe("unknown");
    expect(after.entry).toBe(MARK);
    const exactBefore = exactLongLiq(TRUE_ENTRY, CAPITAL);
    const exactAfter = exactLongLiq(after.entry, CAPITAL + PNL);
    expect(Math.abs(exactBefore - exactAfter)).toBeLessThan(1); // < 1 e6 tick
  });

  it("the displayed (SDK) liq on the unknown path is within the SDK formula's own error of that exact liq", () => {
    const exact = exactLongLiq(TRUE_ENTRY, CAPITAL); // ≈ $52.63
    const unknownPath = Number(computeLiqPrice(MARK, CAPITAL + PNL, SIZE, MM_BPS)); // ≈ $51.48
    const derivedPath = Number(computeLiqPrice(TRUE_ENTRY, CAPITAL, SIZE, MM_BPS)); // ≈ $52.38
    expect(Math.abs(unknownPath - exact) / exact).toBeLessThan(0.03);
    expect(Math.abs(derivedPath - exact) / exact).toBeLessThan(0.03);
    // What a REAL fabrication looks like: the mark as entry against the
    // un-crystallized capital — off by ~36%. That is not what the hook feeds.
    const fabricated = Number(computeLiqPrice(MARK, CAPITAL, SIZE, MM_BPS));
    expect(Math.abs(fabricated - exact) / exact).toBeGreaterThan(0.3);
  });

  it("so describeLiqPrice keeps showing that price when the entry is unknown (pinned, deliberate)", () => {
    const d = describeLiqPrice({
      liqPriceE6: computeLiqPrice(MARK, CAPITAL + PNL, SIZE, MM_BPS),
      positionSize: SIZE,
      capital: CAPITAL + PNL,
      markPriceE6: MARK,
      maintenanceMarginBps: MM_BPS,
      hasResolvedEntry: false,
    });
    expect(d.kind).toBe("price");
  });

  it("…while the ZERO claim ('covered') still requires a resolved entry", () => {
    const d = describeLiqPrice({
      liqPriceE6: 0n,
      positionSize: SIZE,
      capital: CAPITAL * 100n,
      markPriceE6: MARK,
      maintenanceMarginBps: MM_BPS,
      hasResolvedEntry: false,
    });
    expect(d.kind).toBe("unknown");
  });
});
