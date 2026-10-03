import { describe, expect, it } from "vitest";
import { describeLiqPrice, type LiqPriceDisplayInput } from "@/lib/liq-price-display";
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
