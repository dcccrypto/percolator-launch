// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_HOURS,
  downsample,
  latestPerSlab,
  parseCapacityQuery,
  sideLabel,
  toPoint,
  type CapacityRowDb,
} from "@/lib/v21/capacity-snapshots";

const SLAB = "11111111111111111111111111111111";
const row = (o: Partial<CapacityRowDb> = {}): CapacityRowDb => ({ slab: SLAB, ts: "2026-10-05T12:00:00.000Z", ...o });

describe("toPoint", () => {
  it("converts atoms to dollars (6 dp), bps to fractions and x100 to multiples", () => {
    const p = toPoint(
      row({
        capacity_notional_atoms: "25000000000", // $25,000
        lp_equity_atoms: 1_500_000,
        earn_nav_atoms: "5500000",
        allocated_atoms: "2000000",
        nav_per_share: "1.250000000",
        u_long_bps: 6000,
        u_short_bps: 250,
        max_leverage_long_x100: 350,
        max_leverage_short_x100: 1000,
        l_ceil_x100: 1000,
      }),
    )!;
    expect(p.capacityUsd).toBe(25_000);
    expect(p.lpEquityUsd).toBe(1.5);
    expect(p.earnNavUsd).toBe(5.5);
    expect(p.allocatedUsd).toBe(2);
    expect(p.navPerShare).toBe(1.25);
    expect(p.utilLong).toBe(0.6);
    expect(p.utilShort).toBe(0.025);
    expect(p.maxLevLong).toBe(3.5);
    expect(p.maxLevShort).toBe(10);
    expect(p.ceilLev).toBe(10);
    expect(p.t).toBe(Date.parse("2026-10-05T12:00:00.000Z"));
  });
  it("a missing or garbage field is null, never NaN; a bad timestamp drops the row", () => {
    const p = toPoint(row({ lp_equity_atoms: "abc", u_long_bps: null, nav_per_share: null }))!;
    expect(p.lpEquityUsd).toBeNull();
    expect(p.utilLong).toBeNull();
    expect(p.navPerShare).toBeNull();
    expect(p.capacityUsd).toBeNull();
    expect(toPoint(row({ ts: "not a date" }))).toBeNull();
  });
  it("closed sides and flags carry through", () => {
    const p = toPoint(row({ long_closed: true, hlock_active: true, adl_active: false }))!;
    expect(p.longClosed).toBe(true);
    expect(p.shortClosed).toBe(false);
    expect(p.hlockActive).toBe(true);
    expect(p.adlActive).toBe(false);
  });
});

describe("latestPerSlab", () => {
  it("keeps the newest point per slab whatever the input order", () => {
    const A = "So11111111111111111111111111111111111111112";
    const rows = [
      row({ slab: SLAB, ts: "2026-10-05T12:00:00Z", lp_equity_atoms: 1_000_000 }),
      row({ slab: SLAB, ts: "2026-10-05T12:10:00Z", lp_equity_atoms: 3_000_000 }),
      row({ slab: A, ts: "2026-10-05T12:05:00Z", lp_equity_atoms: 7_000_000 }),
      row({ slab: SLAB, ts: "2026-10-05T12:05:00Z", lp_equity_atoms: 2_000_000 }),
    ];
    const out = latestPerSlab(rows);
    expect(out).toHaveLength(2);
    expect(out.find((p) => p.slab === SLAB)!.lpEquityUsd).toBe(3);
    expect(out.find((p) => p.slab === A)!.lpEquityUsd).toBe(7);
  });
});

describe("downsample", () => {
  it("leaves short series alone and keeps first and last of long ones", () => {
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    const out = downsample(xs, 400);
    expect(out).toHaveLength(400);
    expect(out[0]).toBe(0);
    expect(out[399]).toBe(999);
    expect([...out].sort((a, b) => a - b)).toEqual(out);
  });
});

describe("parseCapacityQuery", () => {
  const q = (s: string) => parseCapacityQuery(new URLSearchParams(s));
  it("defaults, and accepts a base58 slab and hours in range", () => {
    expect(q("")).toEqual({ ok: true, slab: null, hours: 24 });
    expect(q(`slab=${SLAB}&hours=6`)).toEqual({ ok: true, slab: SLAB, hours: 6 });
  });
  it("rejects a bad slab and out-of-range or fractional hours", () => {
    expect(q("slab=not%20a%20slab%27%3B--").ok).toBe(false);
    expect(q("hours=0").ok).toBe(false);
    expect(q(`hours=${MAX_HOURS + 1}`).ok).toBe(false);
    expect(q("hours=1.5").ok).toBe(false);
  });
});

describe("sideLabel", () => {
  it("closed wins; unknown is explicit; leverage is rounded for readability", () => {
    expect(sideLabel(10, true)).toBe("closed");
    expect(sideLabel(null, false)).toBe("unknown");
    expect(sideLabel(3.456, false)).toBe("3.5x");
    expect(sideLabel(12.4, false)).toBe("12x");
  });
});
