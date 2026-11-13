// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeMarkPnl } from "@percolatorct/sdk";
import {
  backSolveEntryFromPnl,
  computeMarkPnlCollateral,
  estimateEntryFromPnl,
  resolveEntryPrice,
} from "@/lib/trading";
import { describeEntryPrice } from "@/lib/entry-price-display";

/**
 * #2672 — resolveEntryPrice labelled an entry "derived" (display-trusted) when
 * the back-solve had produced nothing but the MARK: the #2660 fabrication with
 * a trusted label. Numbers are the issue's own measurements and live playground
 * marks (2026-09-29 /api/markets: BURNIE $0.001495, SOLCAT $0.000132).
 */

// The reported position (#2660 / #2672): 12_140_047_588 base atoms at $0.019400.
const REPORTED_SIZE = 12_140_047_588n;
const REPORTED_MARK = 19_400n;

describe("#2672 mechanism 1 — truncation below one e6 tick", () => {
  it.each([1n, -1n, 5_000n, -12_139n])(
    "pnl=%s on the reported position → unknown, not a 'derived' mark",
    (pnl) => {
      // Pre-fix output, pinned: the estimate is exactly the mark.
      expect(estimateEntryFromPnl(REPORTED_SIZE, pnl, REPORTED_MARK)).toBe(REPORTED_MARK);
      const r = resolveEntryPrice(REPORTED_SIZE, 0n, pnl, REPORTED_MARK);
      expect(r.source).toBe("unknown");
      expect(describeEntryPrice({ entryE6: r.entry, source: r.source }).known).toBe(false);
    },
  );

  it("one atom past the tick boundary still derives a real, non-mark entry", () => {
    // |pnl| = absPos / 1e6 (rounded up) → diff = 1 tick.
    const r = resolveEntryPrice(REPORTED_SIZE, 0n, 12_141n, REPORTED_MARK);
    expect(r.source).toBe("derived");
    expect(r.entry).toBe(REPORTED_MARK - 1n); // winning long: entry below mark
  });

  it("sub-cent memecoin: a -$9.99 PnL on a 10M BURNIE long no longer shows as flat", () => {
    const BURNIE_MARK = 1_495n; // $0.001495
    const size = 10_000_000_000_000n; // 10M tokens @ 6dp ≈ $14,950 notional
    const pnl = -9_999_999n; // -$9.999999 in 6dp collateral atoms

    // What the trader used to see: entry == mark, and the PnL every surface
    // computes from that entry is exactly zero — a -$10 loss read as flat.
    const oldEntry = estimateEntryFromPnl(size, pnl, BURNIE_MARK);
    expect(oldEntry).toBe(BURNIE_MARK);
    expect(computeMarkPnlCollateral(computeMarkPnl(size, oldEntry, BURNIE_MARK), BURNIE_MARK)).toBe(0n);

    expect(resolveEntryPrice(size, 0n, pnl, BURNIE_MARK).source).toBe("unknown");

    // $10.00 is one tick on this position: that IS expressible, and derives.
    const r = resolveEntryPrice(size, 0n, -10_000_000n, BURNIE_MARK);
    expect(r).toEqual({ entry: 1_496n, source: "derived" });
  });

  it("SOLCAT (132 e6): one tick is 0.76% of the price — the swallowed band scales with it", () => {
    const SOLCAT_MARK = 132n;
    const size = -50_000_000_000_000n; // 50M short
    expect(resolveEntryPrice(size, 0n, 49_999_999n, SOLCAT_MARK).source).toBe("unknown");
    expect(resolveEntryPrice(size, 0n, 50_000_000n, SOLCAT_MARK)).toEqual({ entry: 133n, source: "derived" });
  });
});

describe("#2672 mechanism 2 — the non-positive clamp", () => {
  it("the issue's case: long, pnl=+9_000_000_000, mark $76 → unknown", () => {
    const size = 100_000n;
    const pnl = 9_000_000_000n;
    const mark = 76_000_000n;
    expect(estimateEntryFromPnl(size, pnl, mark)).toBe(mark); // the clamp, pinned
    expect(backSolveEntryFromPnl(size, pnl, mark)).toBeNull();
    expect(resolveEntryPrice(size, 0n, pnl, mark).source).toBe("unknown");
  });

  it("short whose loss exceeds its notional → unknown (not a confident flat at the mark)", () => {
    const mark = 76_000_000n;
    expect(resolveEntryPrice(-100_000n, 0n, -9_000_000_000n, mark).source).toBe("unknown");
  });

  it("an entry exactly at 1 e6 still derives (the clamp is <= 0, not < 1 tick of zero)", () => {
    // long, mark 2, diff 1 → entry 1
    expect(resolveEntryPrice(1_000_000n, 0n, 1n, 2n)).toEqual({ entry: 1n, source: "derived" });
  });
});

describe("#2672 does not move risk math", () => {
  // `.entry` feeds computeLiqPrice / locked margin / buying power. The fix
  // downgrades the SOURCE only; the value must be byte-identical to the
  // historical estimateEntryFromPnl for every input, derived or not.
  const cases: Array<[bigint, bigint, bigint]> = [
    [REPORTED_SIZE, 1n, REPORTED_MARK],
    [REPORTED_SIZE, -12_139n, REPORTED_MARK],
    [REPORTED_SIZE, 12_141n, REPORTED_MARK],
    [100_000n, 9_000_000_000n, 76_000_000n],
    [-100_000n, -9_000_000_000n, 76_000_000n],
    [200_000n, -25_890_041n, 81_170_000n],
    [-1_000_000n, 3_000_000n, 81_170_000n],
    [10_000_000_000_000n, -9_999_999n, 1_495n],
  ];
  it.each(cases)("size=%s pnl=%s mark=%s: .entry === estimateEntryFromPnl", (size, pnl, mark) => {
    expect(resolveEntryPrice(size, 0n, pnl, mark).entry).toBe(estimateEntryFromPnl(size, pnl, mark));
  });

  it("a real derived entry is unchanged in value AND source", () => {
    const r = resolveEntryPrice(200_000n, 0n, -25_890_041n, 81_170_000n);
    expect(r.source).toBe("derived");
    expect(r.entry).not.toBe(81_170_000n);
  });
});
