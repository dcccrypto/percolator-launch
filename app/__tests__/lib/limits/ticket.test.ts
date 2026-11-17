// @vitest-environment node
/** deriveTicketLimits: every ticket decision (clamp, halt, same-owner, quote, step-down). */
import { describe, it, expect } from "vitest";
import {
  boundVaultLpCap,
  closeLimitNotice,
  deriveTicketLimits,
  feeFitSizeQ,
  growthSideHalt,
  maxFillWithHeadroomQ,
  shrinkSizeInput,
  sizeQToInput,
} from "@/lib/limits/ticket";
import type { GrowthMarketView } from "@/lib/v21/growth-market";
import type { SideLimit } from "@/lib/limits/risk-limits";
import { COPY } from "@/lib/limits/copy";
import { marketLimits, OWNER_A, OWNER_LP, vaultBoundLp } from "./fixtures";

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

describe("r9 MED-2: maxFillWithHeadroomQ never takes headroom below the closing size", () => {
  it("token units: no closing size keeps the headroom; a Max equal to the close fills the exact close", () => {
    expect(maxFillWithHeadroomQ(5_000_000n, "token", 1_000_000n)).toBe(4_987_499n);
    expect(maxFillWithHeadroomQ(234_000n, "token", 1_000_000n, 234_000n)).toBe(234_000n);
  });
  it("token units: past the close (a flip) the headroom comes off only the part above it, never below the close", () => {
    const q = maxFillWithHeadroomQ(5_000_000n, "token", 1_000_000n, 4_999_000n);
    expect(q).toBe(4_999_000n);
    const q2 = maxFillWithHeadroomQ(5_000_000n, "token", 1_000_000n, 1_000_000n);
    expect(q2).toBe(4_987_499n);
  });
  it("usd units: a Max equal to the close fills the exact close", () => {
    expect(maxFillWithHeadroomQ(234_000_000n, "usd", 1_000_000n, 234_000_000n)).toBe(234_000_000n);
    expect(maxFillWithHeadroomQ(234_000_000n, "usd", 1_000_000n)).toBeLessThan(234_000_000n);
  });
  it("lot market: 100 lots closing fills 100 lots, not 99", () => {
    expect(maxFillWithHeadroomQ(100n, "token", 1_000_000n)).toBe(99n);
    expect(maxFillWithHeadroomQ(100n, "token", 1_000_000n, 100n)).toBe(100n);
  });
  it("a closing size above Max never raises the fill above Max", () => {
    expect(maxFillWithHeadroomQ(100n, "token", 1_000_000n, 500n)).toBe(100n);
  });
});

describe("deriveTicketLimits: same-owner on a limits-off market", () => {
  it("LP owner with no position: blocked, one same-owner error, close-only", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ state: "off" }), takerOwner: OWNER_LP }));
    expect(t.sameOwner).toBe(true);
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.issues).toEqual([{ kind: "same-owner", severity: "error", title: "Can't open from this wallet", message: COPY.sameOwner }]);
  });
  it("LP owner holding a short: buying (reducing) is allowed, no issue", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ state: "off" }), takerOwner: OWNER_LP, takerPosQ: -5n, direction: "long" }));
    expect(t.sameOwner).toBe(false);
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.issues).toEqual([]);
  });
  it("falls back to sameOwnerLpOwner when the LP account is absent", () => {
    const L = marketLimits({ state: "off", lp: null, sameOwnerLpOwner: OWNER_LP } as never);
    expect(deriveTicketLimits(input({ limits: L, takerOwner: OWNER_LP })).sameOwner).toBe(true);
  });
  it("engine missing counts as off", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ engine: null }) }));
    expect(t.sideLimits).toBeNull();
    expect(t.issues).toEqual([]);
  });
});

describe("deriveTicketLimits: P1 same-owner close-only caps", () => {
  it("LP owner holding a long: short side capped at the position, long side at 0, direction long is blocked", () => {
    const t = deriveTicketLimits(input({ takerOwner: OWNER_LP, takerPosQ: 50_000_000n, direction: "long" }));
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.sideLimits!.short).toEqual({ maxQ: 50_000_000n, reason: "same-owner", halted: false });
    expect(t.sideLimits!.long.maxQ).toBe(0n);
    expect(t.sideLimits!.long.reason).toBe("same-owner");
    expect(t.sameOwner).toBe(true);
    expect(t.issues.map((x) => x.kind)).toContain("same-owner");
  });
  it("detected even when the risk limits did not load (flag P1 off)", () => {
    const L = marketLimits({ flags: { p1: false, p2: false, p2FeeCharged: false, p3: false } });
    const t = deriveTicketLimits(input({ limits: L, takerOwner: OWNER_LP }));
    expect(t.sideLimits).toBeNull();
    expect(t.sameOwnerCloseOnly).toBe(true);
    expect(t.sameOwner).toBe(true);
  });
});

describe("deriveTicketLimits: P2 fee channel", () => {
  const feeMarket = (ext: { maxRequestedFeeBps: number }, maxTradingFeeBps: bigint) => {
    const b = marketLimits();
    return marketLimits({
      riskLimits: { ...b.riskLimits!, matcherExtMode: 1, ...ext } as never,
      engine: { ...b.engine!, maxTradingFeeBps } as never,
      matcher: { ...b.matcher!, inventoryBase: 0n },
    });
  };
  it("channel on, fee within the market max: ok, signed = base + requested + margin, charged", () => {
    const t = deriveTicketLimits(input({ limits: feeMarket({ maxRequestedFeeBps: 100 }, 1_000n), sizeQ: 100_000_000n, feeMarginBps: 3 }));
    expect(t.fee).toEqual({
      channel: { enabled: true, protocolMaxBps: 100 },
      signedFeeBps: 44n,
      requestedBps: 31n,
      marginBps: 3n,
      verdict: "ok",
      charged: true,
    });
    expect(t.issues.map((x) => x.kind)).not.toContain("fee-over-max");
  });
  it("requested fee over the market max => fee-over-max error with the market copy", () => {
    const t = deriveTicketLimits(input({ limits: feeMarket({ maxRequestedFeeBps: 100 }, 12n), sizeQ: 100_000_000n }));
    expect(t.fee!.verdict).toBe("over-market-max");
    expect(t.fee!.signedFeeBps).toBe(12n);
    const issue = t.issues.find((x) => x.kind === "fee-over-max")!;
    expect(issue.severity).toBe("error");
    expect(issue.message).toBe(COPY.feeOverMarketMax);
  });
  it("requested fee over the protocol max => copy names the protocol max percent", () => {
    const t = deriveTicketLimits(input({ limits: feeMarket({ maxRequestedFeeBps: 20 }, 1_000n), direction: "short", sizeQ: 900_000_000n }));
    expect(t.fee!.verdict).toBe("over-protocol-max");
    expect(t.issues.find((x) => x.kind === "fee-over-max")!.message).toBe(COPY.feeOverProtocolMax("0.20%"));
  });
  it("channel off: fee is the base, not charged unless the p2FeeCharged flag is set", () => {
    const t = deriveTicketLimits(input({ sizeQ: 100_000_000n, direction: "short" }));
    expect(t.fee).toMatchObject({ channel: { enabled: false, protocolMaxBps: 0 }, signedFeeBps: 10n, requestedBps: 0n, verdict: "ok", charged: false });
    const charged = deriveTicketLimits(
      input({ limits: marketLimits({ flags: { p1: true, p2: true, p2FeeCharged: true, p3: true } }), sizeQ: 100_000_000n, direction: "short" }),
    );
    expect(charged.fee!.charged).toBe(true);
  });
  it("growth-unknown (growthRoom loading) => no quote and no fee", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits({ growthRoom: "loading" } as never) }));
    expect(t.quote).toBeNull();
    expect(t.fee).toBeNull();
  });
  it("matcherSyncLive with lpRealQ prices from the LP's real position", () => {
    const flat = deriveTicketLimits(input({ direction: "short", sizeQ: 100_000_000n, limits: marketLimits({ matcherSyncLive: true, lpRealQ: 0n } as never) }));
    const stored = deriveTicketLimits(input({ direction: "short", sizeQ: 100_000_000n }));
    expect(flat.quote!.quotePriceE6).not.toBe(stored.quote!.quotePriceE6);
  });
});

describe("feeFitSizeQ", () => {
  const b = marketLimits();
  const L = marketLimits({
    riskLimits: { ...b.riskLimits!, matcherExtMode: 1, maxRequestedFeeBps: 100 } as never,
    engine: { ...b.engine!, maxTradingFeeBps: 35n } as never, // base 10 + requested <= 25
    matcher: { ...b.matcher!, inventoryBase: 0n },
  });
  const over = (q: bigint) => deriveTicketLimits(input({ limits: L, sizeQ: q })).issues.some((x) => x.kind === "fee-over-max");
  it("returns the largest size whose fee fits (boundary is exact)", () => {
    const fit = feeFitSizeQ(input({ limits: L, sizeQ: 500_000_000n }))!;
    expect(fit).toBeGreaterThan(1_000_000n);
    expect(fit).toBeLessThan(100_000_000n);
    expect(over(fit)).toBe(false);
    expect(over(fit + 1n)).toBe(true);
  });
  it("null when the asked size already fits, or is zero", () => {
    expect(feeFitSizeQ(input({ limits: L, sizeQ: 1_000_000n }))).toBeNull();
    expect(feeFitSizeQ(input({ limits: L, sizeQ: 0n }))).toBeNull();
  });
  it("null when not even the smallest size fits", () => {
    const tight = marketLimits({ ...L, engine: { ...L.engine!, maxTradingFeeBps: 10n } as never });
    expect(feeFitSizeQ(input({ limits: tight, sizeQ: 500_000_000n }))).toBeNull();
  });
});

describe("shrinkSizeInput", () => {
  it("steps <= 0 returns the input untouched", () => {
    expect(shrinkSizeInput("1.50", "usd", 0)).toBe("1.50");
    expect(shrinkSizeInput("abc", "usd", -3)).toBe("abc");
  });
  it("unparseable input is returned as is", () => {
    expect(shrinkSizeInput("1e5", "token", 1)).toBe("1e5");
    expect(shrinkSizeInput("-2", "usd", 1)).toBe("-2");
  });
  it("USD: one step is one cent, always two decimals", () => {
    expect(shrinkSizeInput("12.34", "usd", 1)).toBe("12.33");
    expect(shrinkSizeInput("12", "usd", 1)).toBe("11.99");
    expect(shrinkSizeInput("12.3", "usd", 5)).toBe("12.25");
    expect(shrinkSizeInput("1.001", "usd", 1)).toBe("0.99"); // extra decimals are truncated to cents first
  });
  it("token: one step is one millionth, trailing zeros trimmed", () => {
    expect(shrinkSizeInput("1.5", "token", 1)).toBe("1.499999");
    expect(shrinkSizeInput("2", "token", 1_000_000)).toBe("1");
    expect(shrinkSizeInput("2.5", "token", 500_000)).toBe("2");
    expect(shrinkSizeInput(".000005", "token", 2)).toBe("0.000003");
  });
  it("never below zero", () => {
    expect(shrinkSizeInput("0.05", "usd", 5)).toBe("0.00");
    expect(shrinkSizeInput("0.05", "usd", 99)).toBe("0.00");
    expect(shrinkSizeInput("0.000001", "token", 1)).toBe("0");
    expect(shrinkSizeInput("", "token", 1)).toBe("0");
  });
});

describe("closeLimitNotice", () => {
  const lim = (over: Partial<SideLimit>): SideLimit => ({ maxQ: 1_000n, reason: "lp-exposure", halted: false, ...over });
  const sides = (short: SideLimit, long: SideLimit) => ({ short, long });
  it("null when there are no limits or no position", () => {
    expect(closeLimitNotice(10n, null)).toBeNull();
    expect(closeLimitNotice(0n, sides(lim({}), lim({})))).toBeNull();
  });
  it("closing a long reads the short side; closing a short reads the long side", () => {
    const s = sides(lim({ halted: true }), lim({}));
    expect(closeLimitNotice(10n, s)).toEqual({ kind: "halted" });
    expect(closeLimitNotice(-10n, s)).toBeNull();
  });
  it("lp-halt with zero room is halted even when the flag is off", () => {
    expect(closeLimitNotice(10n, sides(lim({ reason: "lp-halt", maxQ: 0n }), lim({})))).toEqual({ kind: "halted" });
  });
  it("capped below the position size (lp-halt or lp-exposure), with the cap", () => {
    expect(closeLimitNotice(-300n, sides(lim({}), lim({ maxQ: 100n })))).toEqual({ kind: "capped", maxQ: 100n });
    expect(closeLimitNotice(300n, sides(lim({ reason: "lp-halt", maxQ: 50n }), lim({})))).toEqual({ kind: "capped", maxQ: 50n });
  });
  it("room at or above the position, or another reason, is no notice", () => {
    expect(closeLimitNotice(300n, sides(lim({ maxQ: 300n }), lim({})))).toBeNull();
    expect(closeLimitNotice(300n, sides(lim({ reason: "same-owner", maxQ: 1n }), lim({})))).toBeNull();
  });
});

describe("boundVaultLpCap", () => {
  it("null when P3 is off, the vault is unbound, or there is no LP", () => {
    expect(boundVaultLpCap(marketLimits({ flags: { p1: true, p2: true, p2FeeCharged: false, p3: false } }))).toBeNull();
    expect(boundVaultLpCap(marketLimits({ vaultLp: { ...marketLimits().vaultLp!, bound: false } }))).toBeNull();
    expect(boundVaultLpCap(marketLimits({ lp: null }))).toBeNull();
    expect(boundVaultLpCap(marketLimits({ vaultLp: null }))).toBeNull();
  });
  it("null when the market's LP is not the bound vault LP", () => {
    expect(boundVaultLpCap(marketLimits())).toBeNull();
  });
  it("bound with an explicit stored value: that value", () => {
    expect(boundVaultLpCap(vaultBoundLp(25_000))).toEqual({ levBps: 25_000 });
  });
  it("bound with 0 and no growth: the protocol default 1x", () => {
    expect(boundVaultLpCap(vaultBoundLp(0))).toEqual({ levBps: 10_000 });
  });
  it("bound with 0 on a growth asset: lambdaEff, else the record lambda", () => {
    const g = (lambdaEffBps: number | undefined) =>
      ({ ...vaultBoundLp(0), growth: { long: { lambdaEffBps }, record: { lambdaBps: 7_777 } } }) as never;
    expect(boundVaultLpCap(g(4_321))).toEqual({ levBps: 4_321 });
    expect(boundVaultLpCap(g(undefined))).toEqual({ levBps: 7_777 });
  });
});

describe("growthSideHalt", () => {
  const view = (long: object, short: object) => ({ long, short }) as unknown as GrowthMarketView;
  const open = (headroomQ: bigint) => ({ growthOn: true, closed: false, headroomQ });
  it("null without a view or when growth is off on the side", () => {
    expect(growthSideHalt(null, "long", 0n, null)).toBeNull();
    expect(growthSideHalt(undefined, "long", 0n, null)).toBeNull();
    expect(growthSideHalt(view({ growthOn: false, closed: true }, open(1n)), "long", 0n, null)).toBeNull();
  });
  it("a closed side is 'closed' unless the holder is on the other side (a close)", () => {
    const v = view({ growthOn: true, closed: true }, open(5n));
    expect(growthSideHalt(v, "long", 0n, null)).toBe("closed");
    expect(growthSideHalt(v, "long", 3n, null)).toBe("closed"); // already long: an add
    expect(growthSideHalt(v, "long", -3n, null)).toBeNull(); // short holder buying = closing
    expect(growthSideHalt(view(open(5n), { growthOn: true, closed: true }), "short", 3n, null)).toBeNull();
  });
  it("flat taker: room under the minimum leg is 'min-leg'; at the minimum is fine", () => {
    const v = view(open(99n), open(100n));
    expect(growthSideHalt(v, "long", 0n, 100n)).toBe("min-leg");
    expect(growthSideHalt(v, "short", 0n, 100n)).toBeNull();
    expect(growthSideHalt(v, "long", 0n, 0n)).toBeNull();
    expect(growthSideHalt(v, "long", 0n, null)).toBeNull();
  });
  it("a holder is not min-leg paused, but a room under one step reads 'step'", () => {
    const v = view(open(5n), open(5n));
    expect(growthSideHalt(v, "long", 10n, 100n)).toBeNull();
    expect(growthSideHalt(v, "long", 10n, 100n, 6n)).toBe("step");
    expect(growthSideHalt(v, "long", 10n, 100n, 5n)).toBeNull();
    expect(growthSideHalt(v, "long", 0n, null, 6n)).toBe("step");
    expect(growthSideHalt(v, "long", 0n, null, 0n)).toBeNull();
  });
  it("a missing headroom counts as 0 room; a reduce is never paused", () => {
    const v = view({ growthOn: true, closed: false }, open(0n));
    expect(growthSideHalt(v, "long", 0n, 1n)).toBe("min-leg");
    expect(growthSideHalt(v, "long", -4n, 1n, 1n)).toBeNull();
    expect(growthSideHalt(v, "short", 4n, 1n, 1n)).toBeNull();
  });
});
