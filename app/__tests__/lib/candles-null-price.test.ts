import { describe, expect, it } from "vitest";
import { bucketCandles } from "@/lib/indexer-db";

// A liquidation marker carries no price: `insertTradeRow` documents `price` as
// "null for is_liquidation markers (v17 exposes no side/size/price for forced
// closes)". Such a row is not a trade at price zero — it is a row with no price,
// and it must never become a candle.
//
// `bucketCandles` guarded with `!Number.isFinite(price)`, which does not reject
// it: `Number(null)` is `0`, and `0` is finite. The row therefore became a real
// OHLC bar at zero, and the chart rendered a vertical drop to 0 with a -100%
// change badge.
//
// Observed on the live playground for SOL-PERP (slab Azaggu...qdhr) on
// 2026-09-24, where /api/candles returned:
//   09-24 04:00  o=h=l=c=114.629292  v=1744752
//   09-24 13:00  o=h=l=c=0           v=69793972   <- this row
//
// The upstream cause of those rows is separate and lives in percolator-indexer
// (v17 liquidation detection still running against v18, producing phantom
// markers). This guard is the display-side half: whatever writes a null price,
// a candle must not be manufactured from it.

const at = (iso: string) => new Date(iso);

describe("bucketCandles rejects rows without a price", () => {
  it("does not manufacture a zero bar from a null-price liquidation marker", () => {
    const out = bucketCandles(
      [
        { price: "114.629292", size: "5", created_at: at("2026-09-24T04:10:00Z") },
        // liquidation marker — no price, no side
        { price: null as unknown as string, size: "1000", created_at: at("2026-09-24T13:10:00Z") },
      ],
      3600,
    );

    expect(out.s).toBe("ok");
    expect(out.c).not.toContain(0);
    expect(out.t).toHaveLength(1);
    expect(out.c[0]).toBeCloseTo(114.629292, 6);
  });

  it("rejects a row whose price is the string '0' as well", () => {
    const out = bucketCandles(
      [
        { price: "114.629292", size: "5", created_at: at("2026-09-24T04:10:00Z") },
        { price: "0", size: "1000", created_at: at("2026-09-24T13:10:00Z") },
      ],
      3600,
    );
    expect(out.c).not.toContain(0);
    expect(out.t).toHaveLength(1);
  });

  it("rejects a negative price", () => {
    const out = bucketCandles(
      [{ price: "-5", size: "1", created_at: at("2026-09-24T04:10:00Z") }],
      3600,
    );
    // every row dropped -> no_data, not a bar at -5
    expect(out.t).toHaveLength(0);
  });

  // CONTROL. Without this, the assertions above would also pass if bucketing had
  // simply stopped producing bars at all.
  it("control: real trades still bucket into OHLCV normally", () => {
    const out = bucketCandles(
      [
        { price: "100", size: "1", created_at: at("2026-09-24T04:05:00Z") },
        { price: "120", size: "2", created_at: at("2026-09-24T04:25:00Z") },
        { price: "90", size: "3", created_at: at("2026-09-24T04:45:00Z") },
        { price: "110", size: "4", created_at: at("2026-09-24T05:05:00Z") },
      ],
      3600,
    );

    expect(out.s).toBe("ok");
    expect(out.t).toHaveLength(2);
    // first bucket: open 100, high 120, low 90, close 90, volume 6
    expect(out.o[0]).toBe(100);
    expect(out.h[0]).toBe(120);
    expect(out.l[0]).toBe(90);
    expect(out.c[0]).toBe(90);
    expect(out.v[0]).toBe("6");
    // second bucket
    expect(out.c[1]).toBe(110);
  });
});
