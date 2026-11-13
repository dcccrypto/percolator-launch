// @vitest-environment node
/**
 * Council r3 M9: the ticket quoted deposit / margin / fee for an order it would not fill (room ~ $950 per side, a $5,000 order
 * showed "Deposit 5,517.33 USDC" while the growth line said it fills 10.6165 SOL; Max $39,872.97 against ~$951 room).
 * Root cause: `growthCapQ` (the clip the Max and the size clamp read) was set only for an account whose equity is known; a first
 * trade (takerEquity null) had no cap at all, and the busy-side surcharge was added to the Fee row only when a matcher quote existed.
 * Numbers: the JUP growth view of cap-ticket-2 (room 9,284,648 q on the long side, busy-side fee 443 bps).
 */
import { describe, expect, it } from "vitest";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { feeExtrasLabel, estimatedTotalFeeBps, gateFeeBps, ticketFeeForEstimate } from "@/lib/limits/estimated-fee";
import { sideOverFillable } from "@/lib/limits/fillable-quote";
import { growthMarketView } from "@/lib/v21/growth-market";
import { ALL_ON, marketLimits, OWNER_A } from "../limits/fixtures";
import { engineOpenNeedAtoms, tradableMarginAtoms } from "@/lib/first-trade";
import { marketRaw } from "../v21/fixtures";

const LOT = 1_000_000n;
const PRICE = 32_770_539n;
const ENGINE = { initialMarginBps: 1_000n, effectivePriceE6: PRICE, oiEffLongQ: 40n * LOT, oiEffShortQ: 40n * LOT, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n };
const view = () =>
  growthMarketView({
    raw: marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 }),
    engine: ENGINE,
    lp: { capital: 1_615_084_496n, pnl: 20_474_560n, feeCredits: 0n },
    lpEffectiveQ: -40n * LOT,
    bound: true,
  })!;
const ROOM = 9_284_648n;
const USD_ATOMS = 1_000_000n;
const input = (over: Partial<TicketLimitsInput> = {}): TicketLimitsInput => ({
  limits: marketLimits({ matcher: null }), direction: "long", sizeQ: 100n * LOT, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n,
  growth: view(), takerEquity: null, ...over,
});

describe("M9 a first trade (no account, equity unknown) is capped at the side room", () => {
  it("growthCapQ is the room the program clips to, so Max and the size clamp stop there", () => {
    const t = deriveTicketLimits(input());
    expect(t.growth!.roomQ).toBe(ROOM);
    expect(t.growthCapQ).toBe(ROOM);
  });
  it("an order over the room is flagged as over the fillable amount; at or under it is not", () => {
    const t = deriveTicketLimits(input());
    expect(sideOverFillable(100n * LOT, t.growthCapQ)).toBe(true);
    expect(sideOverFillable(ROOM, t.growthCapQ)).toBe(false);
    expect(sideOverFillable(1n * LOT, t.growthCapQ)).toBe(false);
    expect(sideOverFillable(100n * LOT, null)).toBe(false);
  });
  it("a flip by a holder (equity unknown): the cap is the closing leg PLUS the side's room", () => {
    const g = view();
    const t = deriveTicketLimits(input({ direction: "short", takerPosQ: 3n * LOT }));
    expect(g.short.headroomQ! > 0n).toBe(true);
    expect(t.growthCapQ).toBe(3n * LOT + g.short.headroomQ!);
    const l = deriveTicketLimits(input({ direction: "long", takerPosQ: -2n * LOT }));
    expect(l.growthCapQ).toBe(2n * LOT + ROOM);
    // adding to the same side has no closing part
    expect(deriveTicketLimits(input({ direction: "long", takerPosQ: 2n * LOT })).growthCapQ).toBe(ROOM);
  });
  it("a known-equity account keeps its (tighter) gate cap, never loosened", () => {
    const t = deriveTicketLimits(input({ takerEquity: 1_379_387_398n, takerPosQ: 40n * LOT }));
    expect(t.growthCapQ!).toBeLessThanOrEqual(ROOM);
  });
});

describe("M9 the busy-side surcharge is in the Fee even with no matcher quote", () => {
  it("fee estimate = base + busy-side bps, on the clipped fill", () => {
    const t = deriveTicketLimits(input());
    expect(t.fee).toBeNull(); // no matcher quote on this market
    const util = BigInt(t.growth!.fee!.utilFeeBps);
    expect(util > 0n).toBe(true);
    expect(estimatedTotalFeeBps(30n, ticketFeeForEstimate(t))).toBe(30n + util);
    expect(gateFeeBps(30n, input())).toBe(30n + util);
  });
  it("with a CHARGED matcher quote the quote fee and the surcharge are each counted once", () => {
    const base0 = marketLimits();
    const charged = marketLimits({
      matcher: { ...base0.matcher!, kind: 1, v2: undefined, maxTotalBps: 60 },
      flags: { ...ALL_ON, p2FeeCharged: true },
      riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: 1, maxRequestedFeeBps: 100, allDefault: false },
    });
    const t = deriveTicketLimits(input({ limits: charged }));
    expect(t.fee?.charged).toBe(true);
    expect(t.fee!.requestedBps).toBe(60n);
    const util = BigInt(t.growth!.fee!.utilFeeBps);
    expect(util > 0n).toBe(true);
    expect(t.fee!.utilFeeBps).toBe(util); // the surcharge is already inside the quote's fee
    expect(estimatedTotalFeeBps(30n, ticketFeeForEstimate(t))).toBe(30n + 60n + util);
  });
  it("the tooltip names only the parts that are charged", () => {
    expect(feeExtrasLabel(null)).toBe("");
    expect(feeExtrasLabel({ charged: false, requestedBps: 0n, utilFeeBps: 443n })).toBe("the busy-side fee");
    expect(feeExtrasLabel({ charged: true, requestedBps: 60n })).toBe("the market maker's quote fee");
    expect(feeExtrasLabel({ charged: true, requestedBps: 60n, utilFeeBps: 5n })).toBe("the market maker's quote fee and the busy-side fee");
    expect(feeExtrasLabel({ charged: true, requestedBps: 0n, utilFeeBps: 0n })).toBe("");
  });
  it("deposit level: the engine gate fee includes the busy fee, so the engine need rises and the tradable balance falls", () => {
    const withUtil = gateFeeBps(30n, input());
    expect(withUtil > 30n).toBe(true);
    const notional = 1_000n * USD_ATOMS;
    expect(engineOpenNeedAtoms(notional, 1_000n, withUtil).fee).toBeGreaterThan(engineOpenNeedAtoms(notional, 1_000n, 30n).fee);
    const tradable = (feeBps: bigint) => tradableMarginAtoms({ inMarketAvailable: 0n, walletAtoms: 39_000n * USD_ATOMS, leverage100: 100, feeBps, initialMarginBps: 1_000n });
    expect(tradable(withUtil)).toBeLessThan(tradable(30n));
  });
  it("round-1 numbers: $5,000 asked, ~$950 room -> quote on the fillable amount", () => {
    // 10.6165 SOL fillable at ~$89.5: the typed 55.8 SOL is clamped; deposit scales with the fill, not the ask.
    const price = 89_500_000n;
    const room = 10_616_500n;
    const ask = (5_000n * 1_000_000n * 1_000_000n) / price;
    expect(sideOverFillable(ask, room)).toBe(true);
    const fillable = ask > room ? room : ask;
    const notional = (fillable * price) / 1_000_000n;
    expect(notional / 1_000_000n).toBe(950n);
  });
});
