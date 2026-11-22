import { describe, expect, it } from "vitest";
import {
  computePositionLeverage,
  describePositionLeverage,
  POSITION_LEVERAGE_TITLE,
} from "@/lib/position-leverage";

const base = { markPriceE6: 100_000_000n, capital: 1_000_000_000n, pnl: 0n, collateralDecimals: 6 };

describe("computePositionLeverage", () => {
  it("notional / (capital + pnl): 40 base @ $100 = $4000 on $1000 -> 4x", () => {
    const r = computePositionLeverage({ ...base, sizeQ: 40_000_000n });
    expect(r).toMatchObject({ kind: "ok", leverage: 4, notionalAtoms: 4_000_000_000n, equityAtoms: 1_000_000_000n });
  });

  it("equity includes pnl: +500 pnl lowers leverage, -500 raises it", () => {
    const up = computePositionLeverage({ ...base, sizeQ: 40_000_000n, pnl: 500_000_000n });
    const down = computePositionLeverage({ ...base, sizeQ: 40_000_000n, pnl: -500_000_000n });
    expect(up).toMatchObject({ kind: "ok", leverage: 2.6666 });
    expect(down).toMatchObject({ kind: "ok", leverage: 8 });
  });

  it("uses |size|: a short of the same size has the same leverage", () => {
    const l = computePositionLeverage({ ...base, sizeQ: 40_000_000n });
    const s = computePositionLeverage({ ...base, sizeQ: -40_000_000n });
    expect(s).toEqual(l);
  });

  it("scales with the mark price", () => {
    const r = computePositionLeverage({ ...base, sizeQ: 40_000_000n, markPriceE6: 50_000_000n });
    expect(r).toMatchObject({ kind: "ok", leverage: 2 });
  });

  it("9-dec collateral: engine price_e6 is already in collateral atoms, no decimals factor", () => {
    const r = computePositionLeverage({
      sizeQ: 40_000_000n,
      markPriceE6: 100_000_000_000n, // $100 expressed in 9-dec collateral atoms (e6)
      capital: 1_000_000_000_000n, // $1000 at 9 decimals
      pnl: 0n,
      collateralDecimals: 9,
    });
    expect(r).toMatchObject({ kind: "ok", leverage: 4 });
  });

  it("equity <= 0 -> no-equity (never Infinity / negative leverage)", () => {
    expect(computePositionLeverage({ ...base, sizeQ: 1_000_000n, pnl: -1_000_000_000n })).toMatchObject({ kind: "no-equity" });
    expect(computePositionLeverage({ ...base, sizeQ: 1_000_000n, capital: 0n })).toMatchObject({ kind: "no-equity" });
    expect(computePositionLeverage({ ...base, sizeQ: 1_000_000n, pnl: -2_000_000_000n })).toMatchObject({ kind: "no-equity" });
  });

  it("flat / unknown inputs", () => {
    expect(computePositionLeverage({ ...base, sizeQ: 0n })).toEqual({ kind: "flat" });
    expect(computePositionLeverage({ ...base, sizeQ: null })).toEqual({ kind: "unknown" });
    expect(computePositionLeverage({ ...base, sizeQ: 1n, markPriceE6: 0n })).toEqual({ kind: "unknown" });
    expect(computePositionLeverage({ ...base, sizeQ: 1n, markPriceE6: null })).toEqual({ kind: "unknown" });
    expect(computePositionLeverage({ ...base, sizeQ: 1n, capital: undefined })).toEqual({ kind: "unknown" });
    expect(computePositionLeverage({ ...base, sizeQ: 1n, pnl: null })).toEqual({ kind: "unknown" });
  });

  it("u64::MAX sentinel capital / pnl is unknown, not a huge equity", () => {
    const MAX = 2n ** 64n - 1n;
    expect(computePositionLeverage({ ...base, sizeQ: 1_000_000n, capital: MAX })).toEqual({ kind: "unknown" });
    expect(computePositionLeverage({ ...base, sizeQ: 1_000_000n, pnl: MAX })).toEqual({ kind: "unknown" });
  });
});

describe("describePositionLeverage", () => {
  it("formats with the multiplication sign and the cross-margin tooltip", () => {
    const d = describePositionLeverage(computePositionLeverage({ ...base, sizeQ: 42_000_000n }));
    expect(d).toMatchObject({ text: "4.2×", known: true, title: POSITION_LEVERAGE_TITLE });
    expect(d.title).toMatch(/cross/i);
    expect(d.title).toMatch(/not the leverage you opened at/i);
  });
  it("rounds to <=2dp without a dangling zero (4.999 -> 5×, 4.5 -> 4.5×)", () => {
    expect(describePositionLeverage({ kind: "ok", leverage: 4.9996, notionalAtoms: 1n, equityAtoms: 1n }).text).toBe("5×");
    expect(describePositionLeverage({ kind: "ok", leverage: 4.5, notionalAtoms: 1n, equityAtoms: 1n }).text).toBe("4.5×");
  });
  it("whole numbers have no decimals; dashes when not displayable", () => {
    expect(describePositionLeverage(computePositionLeverage({ ...base, sizeQ: 40_000_000n })).text).toBe("4×");
    expect(describePositionLeverage({ kind: "unknown" }).text).toBe("—");
    expect(describePositionLeverage({ kind: "no-equity", equityAtoms: -1n }).text).toBe("—");
    expect(describePositionLeverage({ kind: "flat" }).known).toBe(false);
  });
});
