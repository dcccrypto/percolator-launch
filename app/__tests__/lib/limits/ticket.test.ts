// @vitest-environment node
/** deriveTicketLimits: every ticket decision (clamp, halt, same-owner, quote, step-down). */
import { describe, it, expect } from "vitest";
import { deriveTicketLimits, sizeQToInput } from "@/lib/limits/ticket";
import { marketLimits, OWNER_A, OWNER_LP } from "./fixtures";

const input = (over: Partial<Parameters<typeof deriveTicketLimits>[0]> = {}) => ({
  limits: marketLimits(),
  direction: "long" as const,
  sizeQ: 100_000_000n,
  takerPosQ: 0n,
  takerOwner: OWNER_A,
  leverage: 2,
  limitPriceE6: 0n,
  ...over,
});

describe("deriveTicketLimits", () => {
  it("off => no limits, no issues", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ state: "off" }) }));
    expect(t.sideLimits).toBeNull();
    expect(t.issues).toEqual([]);
  });

  it("LP short 400 with $100 at 10x: taker long room 600, taker short room 1400", () => {
    const t = deriveTicketLimits(input());
    expect(t.sideLimits!.long.maxQ).toBe(600_000_000n);
    expect(t.sideLimits!.short.maxQ).toBe(1_400_000_000n);
    expect(t.clampToQ).toBeNull();
  });

  it("over headroom => clampToQ = the side max (and no blocking issue)", () => {
    const t = deriveTicketLimits(input({ sizeQ: 900_000_000n }));
    expect(t.clampToQ).toBe(600_000_000n);
    expect(t.issues.filter((x) => x.severity === "error")).toEqual([]);
  });

  it("floored LP: the side that grows it is halted (blocking), the reducing side is not", () => {
    const L = marketLimits({ lp: { ...marketLimits().lp!, capital: 0n } });
    const long = deriveTicketLimits(input({ limits: L, direction: "long" }));
    expect(long.halted).toEqual({ long: true, short: false });
    expect(long.issues.map((x) => x.kind)).toContain("halted");
    const short = deriveTicketLimits(input({ limits: L, direction: "short" }));
    expect(short.issues.map((x) => x.kind)).not.toContain("halted");
  });

  it("same-owner: LP owner and asset_admin are blocked", () => {
    expect(deriveTicketLimits(input({ takerOwner: OWNER_LP })).sameOwner).toBe(true);
    const admin = new Uint8Array(32).fill(9);
    expect(deriveTicketLimits(input({ limits: marketLimits({ assetAdmin: admin }), takerOwner: admin })).sameOwner).toBe(true);
    expect(deriveTicketLimits(input()).sameOwner).toBe(false);
  });

  it("P2 quote flags a too-tight slippage limit (flat book)", () => {
    const flat = marketLimits({ matcher: { ...marketLimits().matcher!, inventoryBase: 0n } });
    const t = deriveTicketLimits(input({ limits: flat, sizeQ: 100_000_000n, limitPriceE6: 1_000_001n }));
    expect(t.quote!.kind).toBe("adaptive");
    expect(t.quote!.totalBps).toBe(31n);
    expect(t.issues.map((x) => x.kind)).toContain("quote-slippage");
    const ok = deriveTicketLimits(input({ limits: flat, sizeQ: 100_000_000n, limitPriceE6: 1_050_000n }));
    expect(ok.issues.map((x) => x.kind)).not.toContain("quote-slippage");
  });

  it("P2 quote on a crowded book: joining the crowd past the skew knee quotes a zero fill; the thin side fills with a rebate", () => {
    const crowdJoin = deriveTicketLimits(input({ sizeQ: 100_000_000n }));
    expect(crowdJoin.quote!.fillQ).toBe(0n);
    expect(crowdJoin.quote!.clippedByTotal).toBe(true);
    const thin = deriveTicketLimits(input({ direction: "short", sizeQ: 100_000_000n }));
    expect(thin.quote!.fillQ).toBe(100_000_000n);
    expect(thin.quote!.skewBps! < 0n).toBe(true);
  });

  it("P3 step-down: joining the crowd caps leverage; the thin side keeps base", () => {
    // vault LP short 400 of cap 1000 (40% crowd): a new long's IMR >= 40% at size => max 2x
    const t = deriveTicketLimits(input({ leverage: 5 }));
    expect(t.stepDown!.stepped).toBe(true);
    expect(t.stepDown!.maxLeverage).toBe(2);
    expect(t.issues.map((x) => x.kind)).toContain("step-down");
    const thin = deriveTicketLimits(input({ direction: "short", leverage: 5 }));
    expect(thin.stepDown!.stepped).toBe(false);
    expect(thin.issues.map((x) => x.kind)).not.toContain("step-down");
  });

  it("P1 unreadable bytes => a warning, never a guessed cap", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ state: "error", riskLimits: null }) }));
    expect(t.sideLimits).toBeNull();
    expect(t.issues.map((x) => x.kind)).toContain("limits-unavailable");
  });
});

describe("sizeQToInput", () => {
  it("token units and USD (floored to cents)", () => {
    expect(sizeQToInput(600_000_000n, "token", 1_000_000n)).toBe("600");
    expect(sizeQToInput(1_234_567n, "token", 1_000_000n)).toBe("1.234567");
    expect(sizeQToInput(1_234_567n, "usd", 2_000_000n)).toBe("2.46");
  });

  // GO1106 verify (low): "Use 1 lot" in dollar mode filled $65.47 for a $65.4712 lot, which is still under one lot.
  it("Use 1 lot (USD, rounded up): the filled dollars re-read as at least one lot", () => {
    const LOT = 1_000_000n; // POS_SCALE_V22: one lot in q
    const lotPriceE6 = 65_471_200n; // $65.4712 per lot
    expect(sizeQToInput(LOT, "usd", lotPriceE6)).toBe("65.47"); // the default (max clamp) still floors
    const up = sizeQToInput(LOT, "usd", lotPriceE6, 0, "up");
    expect(up).toBe("65.48");
    const usdAtoms = BigInt(up.replace(".", "")) * 10_000n;
    expect((usdAtoms * 1_000_000n) / lotPriceE6).toBeGreaterThanOrEqual(LOT);
    // An exact-cent notional is not bumped a cent.
    expect(sizeQToInput(LOT, "usd", 65_470_000n, 0, "up")).toBe("65.47");
    // Token mode is exact either way.
    expect(sizeQToInput(LOT, "token", lotPriceE6, 0, "up")).toBe("1");
  });
});
