/**
 * Unit tests for lib/slab-max-leverage.ts — the only leverage-maths file
 * that had no tests. It derives the market's static max leverage from the
 * slab's on-chain initial_margin_bps, via the same leverageFromMarginBps
 * the list uses. The Supabase `max_leverage` column is a stored 10 for
 * every market, which is why this helper exists.
 *
 * It does not apply the Council r4 N2 live growth cap (`fillMaxLeverage`),
 * which depends on size, OI and LP and lives in lib/v21/growth-market.ts.
 * Callers that need the live ticket cap must still apply N2 on top.
 */
import { describe, it, expect } from "vitest";
import { maxLeverageFromSlab } from "@/lib/slab-max-leverage";
import { leverageFromMarginBps } from "@/lib/market-params";
import { modeFixtures } from "../helpers/v22-fixtures";

/** V16ConfigAccount starts at 624; initial_margin_bps is the u64 at +62. */
const IMR_OFF = 592 + 32 + 62;

function slabWithImr(bps: number | null, len?: number): Uint8Array {
  const src = Buffer.from(modeFixtures().market);
  const buf = len == null ? Buffer.from(src) : Buffer.alloc(len);
  if (len != null) src.copy(buf, 0, 0, Math.min(len, src.length));
  if (bps != null && IMR_OFF + 8 <= buf.length) buf.writeBigUInt64LE(BigInt(bps), IMR_OFF);
  return new Uint8Array(buf);
}

describe("maxLeverageFromSlab — missing or unreadable input", () => {
  it("is null on empty or too-short bytes", () => {
    expect(maxLeverageFromSlab(new Uint8Array())).toBeNull();
    expect(maxLeverageFromSlab(new Uint8Array(15))).toBeNull();
  });

  it("is null when the bytes are not a wrapper account", () => {
    expect(maxLeverageFromSlab(new Uint8Array(4096))).toBeNull();
    const junk = new Uint8Array(4096);
    junk.fill(0xff);
    expect(maxLeverageFromSlab(junk)).toBeNull();
  });

  it("is null when the engine-config region is cut off", () => {
    // Header + wrapper config can still parse; the IMR u64 at 686 does not fit.
    expect(maxLeverageFromSlab(slabWithImr(1000, 600))).toBeNull();
    expect(maxLeverageFromSlab(slabWithImr(1000, IMR_OFF + 4))).toBeNull();
  });

  it("is null when initial_margin_bps is zero", () => {
    expect(maxLeverageFromSlab(slabWithImr(0))).toBeNull();
  });

  it("is null when a wrapper header is present but the body cannot be parsed", () => {
    // Keep only the wrapper header (magic + VERSION + kind). isWrapperAccount
    // may accept it; parseWrapperConfigV17 should throw, and the helper
    // must catch that and return null rather than leak the exception.
    expect(maxLeverageFromSlab(slabWithImr(null, 16))).toBeNull();
  });
});

describe("maxLeverageFromSlab — rounding and known on-chain bps", () => {
  it("maps the live-devnet bps the list already pins", () => {
    expect(maxLeverageFromSlab(slabWithImr(666))).toBe(15); // SOL
    expect(maxLeverageFromSlab(slabWithImr(1000))).toBe(10); // JUP / launch 10x
    expect(maxLeverageFromSlab(slabWithImr(1538))).toBe(6.5); // COLLECT: floor, not round-up to 7
    expect(maxLeverageFromSlab(slabWithImr(2222))).toBe(4.5); // PAID: floor, not 5
    expect(maxLeverageFromSlab(slabWithImr(2000))).toBe(5);
  });

  it("round-trips a launch 3x market (3334 bps) instead of flooring to 2x", () => {
    expect(Math.floor(10_000 / 3334)).toBe(2);
    expect(maxLeverageFromSlab(slabWithImr(3334))).toBe(3);
  });

  it("agrees with leverageFromMarginBps for every bps it can read", () => {
    for (const bps of [500, 666, 1000, 1500, 1538, 2000, 2222, 3334, 5000, 10_000]) {
      expect(maxLeverageFromSlab(slabWithImr(bps))).toBe(leverageFromMarginBps(bps));
    }
  });

  it("is null when the derived leverage would be zero (extreme margin)", () => {
    // 1_000_000 bps -> 0.01x, floored to 0.1x steps becomes 0, then rejected.
    expect(leverageFromMarginBps(1_000_000)).toBe(0);
    expect(maxLeverageFromSlab(slabWithImr(1_000_000))).toBeNull();
  });
});

describe("maxLeverageFromSlab — caps", () => {
  it("does not clamp a real on-chain cap down to the create-dial MAX_LEVERAGE_X of 10", () => {
    // SOL is 666 bps / 15x on devnet. Clamping here would re-introduce the
    // stored-10 bug this helper was written to fix.
    expect(maxLeverageFromSlab(slabWithImr(666))).toBe(15);
    expect(maxLeverageFromSlab(slabWithImr(666))).toBeGreaterThan(10);
  });

  it("never advertises more than the engine 10000/bps cap for non-launch bps", () => {
    expect(maxLeverageFromSlab(slabWithImr(1538))).toBeLessThanOrEqual(10_000 / 1538);
    expect(maxLeverageFromSlab(slabWithImr(2222))).toBeLessThanOrEqual(10_000 / 2222);
  });

  it("returns 1x at 10_000 bps (100% initial margin)", () => {
    expect(maxLeverageFromSlab(slabWithImr(10_000))).toBe(1);
  });
});

describe("maxLeverageFromSlab — N2 live growth cap", () => {
  /**
   * Council r4 N2 (#3778): on a growth market the ticket must clamp to the
   * live cap for this size (`fillMaxLeverage`), which can be below the
   * market's static IMR cap (the report was "Max leverage now: 6.8x" while
   * the selector still offered 10x).
   *
   * This helper only sees the slab's initial_margin_bps. It must keep
   * returning the static cap, and it is the ceiling the N2 live cap sits
   * under — never the live cap itself.
   */
  it("returns the static IMR cap even when an N2 live cap would be lower", () => {
    const staticCap = maxLeverageFromSlab(slabWithImr(1000));
    expect(staticCap).toBe(10);
    // 1470 bps ≈ 6.80x, the N2 crowd-side figure from the Council report.
    const n2LiveCap = leverageFromMarginBps(1470);
    expect(n2LiveCap).toBe(6.8);
    expect(n2LiveCap).toBeLessThan(staticCap!);
    // Same slab bytes, no size/OI/LP inputs: the helper cannot and must not
    // invent the lower N2 figure.
    expect(maxLeverageFromSlab(slabWithImr(1000))).toBe(staticCap);
  });

  it("the N2 live cap, when present, is at most this static cap", () => {
    const staticCap = maxLeverageFromSlab(slabWithImr(1000));
    expect(staticCap).toBe(10);
    for (const dynBps of [1000, 1200, 1470, 2000, 5000, 10_000]) {
      const live = leverageFromMarginBps(dynBps);
      expect(live).toBeGreaterThan(0);
      expect(live).toBeLessThanOrEqual(staticCap!);
    }
  });
});
