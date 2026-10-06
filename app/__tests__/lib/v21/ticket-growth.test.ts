// @vitest-environment node
/** deriveTicketLimits with a growth view: the fee to sign, the closed side, and "no change when OFF". */
import { describe, it, expect } from "vitest";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { marketLimits, OWNER_A } from "../limits/fixtures";
import { growthMarketView } from "@/lib/v21/growth-market";
import { ENGINE, LP, marketRaw } from "./fixtures";

const growth = (over: { oiLong?: bigint; lpQ?: bigint } = {}) =>
  growthMarketView({
    raw: marketRaw({}),
    engine: { ...ENGINE, oiEffLongQ: over.oiLong ?? 30_000_000n },
    lp: LP,
    lpEffectiveQ: over.lpQ ?? -20_000_000n,
    bound: true,
  })!;

// Fee channel ON (matcher ext mode 1, protocol max 100 bps) so the ticket signs base + quote + margin.
const limits = () => {
  const L = marketLimits();
  return marketLimits({
    riskLimits: { ...L.riskLimits!, matcherExtMode: 1, maxRequestedFeeBps: 100 } as never,
    engine: { ...L.engine!, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
  });
};
const input = (over: Partial<TicketLimitsInput> = {}): TicketLimitsInput => ({
  limits: limits(),
  direction: "long",
  sizeQ: 20_000_000n,
  takerPosQ: 0n,
  takerOwner: OWNER_A,
  leverage: 2,
  limitPriceE6: 0n,
  feeMarginBps: 2,
  ...over,
});

describe("growth OFF changes nothing (today's programs)", () => {
  it("absent, null and undefined growth give an identical ticket", () => {
    const a = deriveTicketLimits(input());
    expect(deriveTicketLimits(input({ growth: null }))).toEqual(a);
    expect(a.growth).toBeNull();
    expect(a.fee?.utilFeeBps).toBeUndefined();
    expect(a.issues.map((x) => x.kind)).not.toContain("growth-closed");
  });
});

describe("the QUOTED fee plus a small tolerance is signed, never the maximum", () => {
  it("a busy-side open signs base + quote + util fee + margin, well under the market maximum", () => {
    const g = growth({ oiLong: 60_000_000n, lpQ: -50_000_000n });
    const t = deriveTicketLimits(input({ growth: g }));
    const util = t.fee!.utilFeeBps!;
    expect(util).toBeGreaterThan(0n);
    expect(t.fee!.signedFeeBps).toBe(30n + t.fee!.requestedBps + util + t.fee!.marginBps);
    expect(t.fee!.marginBps).toBe(2n);
    expect(t.fee!.signedFeeBps).toBeLessThan(630n); // not the cap
    // and the same order with growth OFF signs less by exactly the util fee plus the tolerance on it
    const off = deriveTicketLimits(input());
    expect(t.fee!.signedFeeBps - off.fee!.signedFeeBps).toBe(util + t.fee!.marginBps);
  });
  it("a close never signs a busy-side fee", () => {
    const g = growth({ oiLong: 60_000_000n, lpQ: -50_000_000n });
    const t = deriveTicketLimits(input({ growth: g, direction: "short", takerPosQ: 20_000_000n, sizeQ: 20_000_000n }));
    expect(t.growth!.reducing).toBe(true);
    expect(t.fee?.utilFeeBps).toBeUndefined();
  });
  it("clamps to the market's maximum and says so instead of signing past it", () => {
    const g = growth({ oiLong: 90_000_000n, lpQ: -50_000_000n });
    const L = limits();
    const tight = marketLimits({ ...L, engine: { ...L.engine!, maxTradingFeeBps: 35n } });
    const t = deriveTicketLimits(input({ growth: g, limits: tight, sizeQ: 8_000_000n }));
    expect(t.fee!.signedFeeBps).toBeLessThanOrEqual(35n);
    expect(t.issues.map((x) => x.kind)).toContain("fee-over-max");
  });
});

describe("a full side", () => {
  const full = () => growth({ oiLong: 100_000_000n, lpQ: -50_000_000n });
  it("pauses opening on that side, with calm copy that says closing works", () => {
    const t = deriveTicketLimits(input({ growth: full() }));
    expect(t.halted.long).toBe(true);
    const issue = t.issues.find((x) => x.kind === "growth-closed")!;
    expect(issue.message).toMatch(/full for now/);
    expect(issue.message).toMatch(/reduce or close/);
    expect(t.halted.short).toBe(false);
  });
  it("a holder of the opposite side is NOT paused while composing (they may be closing)", () => {
    const t = deriveTicketLimits(input({ growth: full(), takerPosQ: -10_000_000n, sizeQ: 0n }));
    expect(t.halted.long).toBe(false);
    expect(t.issues.map((x) => x.kind)).not.toContain("growth-closed");
  });
  it("and an order that does close is never refused", () => {
    const t = deriveTicketLimits(input({ growth: full(), takerPosQ: -10_000_000n, sizeQ: 10_000_000n }));
    expect(t.growth!.closed).toBe(false);
    expect(t.halted.long).toBe(false);
  });
});

describe("leverage above the live cap is flagged", () => {
  it("5x is fine at the launch cap; 8x on a side capped near 5.5x is an error with the cap named", () => {
    const g = growth();
    expect(deriveTicketLimits(input({ growth: g, leverage: 5 })).issues.map((x) => x.kind)).not.toContain("growth-leverage");
    const t = deriveTicketLimits(input({ growth: g, leverage: 8 }));
    const issue = t.issues.find((x) => x.kind === "growth-leverage")!;
    expect(issue.message).toMatch(/5\.49x|5\.5x/);
    expect(issue.message).toMatch(/adjusts with market backing/);
  });
});
