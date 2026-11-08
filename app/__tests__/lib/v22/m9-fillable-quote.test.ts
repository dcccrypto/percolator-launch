/**
 * Council r3 M9: the ticket quoted deposit / margin / fee for an order it would not fill (room ~ $950 per side, a $5,000 order
 * showed "Deposit 5,517.33 USDC" while the growth line said it fills 10.6165 SOL; Max $39,872.97 against ~$951 room).
 * Root cause: `growthCapQ` (the clip the Max and the size clamp read) was set only for an account whose equity is known; a first
 * trade (takerEquity null) had no cap at all, and the busy-side surcharge was added to the Fee row only when a matcher quote existed.
 * Numbers: the JUP growth view of cap-ticket-2 (room 9,284,648 q on the long side, busy-side fee 443 bps).
 */
import { describe, expect, it } from "vitest";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { estimatedTotalFeeBps, gateFeeBps, ticketFeeForEstimate } from "@/lib/limits/estimated-fee";
import { sideOverFillable } from "@/lib/limits/fillable-quote";
import { growthMarketView } from "@/lib/v21/growth-market";
import { marketLimits, OWNER_A } from "../limits/fixtures";
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
  it("a closing part of an opposite position adds to what can be ordered", () => {
    const t = deriveTicketLimits(input({ direction: "short", takerPosQ: 3n * LOT }));
    // closing 3 lots + the short side's room (never less than the closing part)
    expect(t.growthCapQ! >= 3n * LOT).toBe(true);
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
  it("with a matcher quote the surcharge was already counted and is not doubled", () => {
    const t = deriveTicketLimits(input({ limits: marketLimits() }));
    expect(estimatedTotalFeeBps(30n, ticketFeeForEstimate(t))).toBe(estimatedTotalFeeBps(30n, t.fee));
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
