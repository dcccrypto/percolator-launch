import { describe, expect, it } from "vitest";
import { describeLiqDistance, describeLiqPrice, type LiqPriceDisplayInput } from "@/lib/liq-price-display";
import { LIQ_PRICE_UNLIQUIDATABLE } from "@/lib/format";
import { computeMarginHealthPct } from "@/lib/margin-health";

const base: LiqPriceDisplayInput = {
  liqPriceE6: 80_000_000n,
  positionSize: 1_000_000n, // 1 unit, e6
  capital: 50_000_000n,
  markPriceE6: 100_000_000n,
  maintenanceMarginBps: 500n,
  hasResolvedEntry: true,
};

describe("describeLiqPrice", () => {
  it("shows the price when one exists, with health in the tooltip", () => {
    const d = describeLiqPrice(base);
    expect(d.kind).toBe("price");
    expect(d.text).toBe("$80.00");
    expect(d.marginHealthPct).toBe(50);
    expect(d.title).toContain("50.0%");
  });

  it("uses the caller's price formatter", () => {
    expect(describeLiqPrice({ ...base, formatPrice: (e6) => `<${e6}>` }).text).toBe("<80000000>");
  });

  it("shows margin health where a long's liquidation price clamps to 0n", () => {
    const d = describeLiqPrice({ ...base, liqPriceE6: 0n, capital: 200_000_000n });
    expect(d.kind).toBe("covered");
    expect(d.text).toBe("200% mgn");
    expect(d.healthThresholdPct).toBe(100);
    expect(d.title).toContain("100%");
  });

  it("shows margin health for a short's u64::MAX sentinel too (was a bare infinity)", () => {
    const d = describeLiqPrice({
      ...base,
      positionSize: -1_000_000n,
      liqPriceE6: LIQ_PRICE_UNLIQUIDATABLE,
      capital: 200_000_000n,
    });
    expect(d.kind).toBe("covered");
    expect(d.text).toBe("200% mgn");
  });

  it("puts the threshold at 100% at any maintenance margin, where the engine liq price disappears (#2987)", () => {
    // The SDK formula's (100 + mm)% (105, 110, ...) was not the engine's line.
    const d = describeLiqPrice({ ...base, liqPriceE6: 0n, maintenanceMarginBps: 1000n });
    expect(d.healthThresholdPct).toBe(100);
  });

  it("agrees with computeMarginHealthPct (no re-derived formula)", () => {
    const d = describeLiqPrice({ ...base, liqPriceE6: 0n, capital: 123_456_789n });
    expect(d.marginHealthPct).toBe(computeMarginHealthPct(123_456_789n, 1_000_000n, 100_000_000n));
  });

  it("never reads a missing entry as covered: 0n without a resolved entry is unknown", () => {
    const d = describeLiqPrice({ ...base, liqPriceE6: 0n, hasResolvedEntry: false, unknownText: "—" });
    expect(d.kind).toBe("unknown");
    expect(d.text).toBe("—");
    // ...but the health that still exists is offered in the tooltip.
    expect(d.title).toContain("Margin health");
  });

  it("never reads a missing mark as covered", () => {
    const d = describeLiqPrice({ ...base, liqPriceE6: 0n, markPriceE6: 0n });
    expect(d.kind).toBe("unknown");
    expect(d.text).toBe("N/A");
    expect(d.marginHealthPct).toBeNull();
  });

  it("is unknown with no position or no price value", () => {
    expect(describeLiqPrice({ ...base, positionSize: 0n }).kind).toBe("unknown");
    expect(describeLiqPrice({ ...base, positionSize: null }).kind).toBe("unknown");
    expect(describeLiqPrice({ ...base, liqPriceE6: null }).kind).toBe("unknown");
  });

  it("does not throw on mistyped numeric inputs (risk readout renders during paint)", () => {
    expect(() =>
      describeLiqPrice({ ...base, capital: 5 as unknown as bigint, maintenanceMarginBps: 500 }),
    ).not.toThrow();
  });
});

describe("describeLiqDistance", () => {
  const dist = (over: Partial<LiqPriceDisplayInput>) => {
    const input = { ...base, ...over };
    return describeLiqDistance(
      describeLiqPrice(input),
      BigInt(input.positionSize ?? 0),
      input.markPriceE6 == null ? null : BigInt(input.markPriceE6),
      input.liqPriceE6,
    );
  };

  it("long: the mark's distance down to the price, over the mark", () => {
    expect(dist({})).toBe("20.0% to liq"); // (100 - 80) / 100
  });

  it("short: the mark's distance up to the price, over the price (the shared helper's convention)", () => {
    expect(dist({ positionSize: -1_000_000n, liqPriceE6: 125_000_000n })).toBe("20.0% to liq"); // (125 - 100) / 125
  });

  it("a crossed price reads 0.0%, not a distance", () => {
    expect(dist({ markPriceE6: 79_000_000n })).toBe("0.0% to liq");
    expect(dist({ positionSize: -1_000_000n, liqPriceE6: 99_000_000n })).toBe("0.0% to liq");
  });

  it("nothing under a covered '% mgn' cell (long clamp or short sentinel)", () => {
    expect(dist({ liqPriceE6: 0n, capital: 200_000_000n })).toBeNull();
    expect(dist({ positionSize: -1_000_000n, liqPriceE6: LIQ_PRICE_UNLIQUIDATABLE, capital: 200_000_000n })).toBeNull();
  });

  it("nothing when the price or the mark is unknown (never the helper's finite 100 fallback)", () => {
    expect(dist({ liqPriceE6: null })).toBeNull();
    expect(dist({ markPriceE6: 0n })).toBeNull();
    expect(dist({ markPriceE6: null })).toBeNull();
    expect(dist({ positionSize: 0n })).toBeNull();
  });
});
