/**
 * QA retest 11:10 (2026-10-14), JUP GtUe5hYy…: LEV-8 second 40-lot long, and swordcat 6fonYScx… paused side.
 * Numbers are the LIVE devnet state read at slot 510954051 (10:17 UTC) and the program's own simulateTransaction results on top of it:
 *   fill 1 (40 lots) leaves A with conservative equity 1,379,387,398 atoms, users' long OI 40e6, LP short 40e6, LP C_m 1,615,084,496,
 *   price 32,770,539 per lot, lambda 1x, kink 50%, ceiling 8x (engine IMR 10%), base fee 30 bps.
 *   PROGRAM: a second 40-lot ask -> Custom 92; the largest second ask that lands is 6,445,678 q (6.445678 lots), fee 502 bps.
 *   swordcat, room left 0.19 lots: a FLAT taker asking 1 or 5 lots -> Custom 113 (leg below band_min_leg_notional); 4 lots with room -> OK.
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { growthMarketView } from "@/lib/v21/growth-market";
import { growthFillCapQ, growthGate } from "@/lib/v22/growth-gate";
import { sizeWithLots } from "@/lib/v22/growth-room";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketLimits, OWNER_A } from "../limits/fixtures";
import { marketRaw } from "../v21/fixtures";

beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const LOT = 1_000_000n;
const PRICE = 32_770_539n;
const A_EQUITY = 1_379_387_398n;
const PROGRAM_MAX_SECOND_ASK_Q = 6_445_678n; // simulated: lands; the next 183 q does not (bisect resolution)
const QUOTE_BPS = 29n; // matcher quote fee seen on that fill (502 bps total = 30 base + 443 utilisation + 29 quote)

const ENGINE = { initialMarginBps: 1_000n, effectivePriceE6: PRICE, oiEffLongQ: 40n * LOT, oiEffShortQ: 40n * LOT, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n };
const jupAfterFill1 = (over: { capital?: bigint; usersLong?: bigint } = {}) =>
  growthMarketView({
    raw: marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 }),
    engine: { ...ENGINE, oiEffLongQ: over.usersLong ?? 40n * LOT },
    lp: { capital: over.capital ?? 1_615_084_496n, pnl: 20_474_560n, feeCredits: 0n },
    lpEffectiveQ: -40n * LOT,
    bound: true,
  })!;

const fmt = { size: (q: bigint) => sizeWithLots(q, { lotExp: 2, ticker: "JUP" }), collateral: (a: bigint) => `$${(Number(a) / 1e6).toFixed(0)}` };
const input = (g: ReturnType<typeof jupAfterFill1>, over: Partial<TicketLimitsInput> = {}): TicketLimitsInput => ({
  limits: marketLimits(), direction: "long", sizeQ: 40n * LOT, takerPosQ: 40n * LOT, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n,
  growth: g, takerEquity: A_EQUITY, format: fmt, ...over,
});
const kinds = (t: ReturnType<typeof deriveTicketLimits>) => t.issues.map((x) => x.kind);

describe("1a. one room: the program's plain N_cap, not the depth-aware quote", () => {
  it("room = floor(C_m*lambda*1e6/(1e4*price)) - users' long OI = 9,284,648 q (9.28 lots)", () => {
    const g = jupAfterFill1();
    expect(g.long.nCapQ).toBe(49_284_648n);
    expect(g.long.headroomQ).toBe(9_284_648n);
    // users' side OI excludes the vault LP's own leg: LP is SHORT 40, so the long side's users OI is the whole 40
    expect(g.short.headroomQ).toBe(49_284_648n - (40n * LOT - 40n * LOT)); // short side: OI 40 minus LP's own 40 leg = 0 users
  });
  it("the ticket decision, the gate and the cap all read that one room", () => {
    const g = jupAfterFill1();
    const t = deriveTicketLimits(input(g));
    expect(t.growth!.roomQ).toBe(9_284_648n);
    expect(t.growthGate!.roomQ).toBe(9_284_648n);
    expect(t.growthGate!.clipQ).toBe(9_284_648n); // the program clips the 40-lot ask to the room
    expect(t.growthCapQ!).toBeLessThanOrEqual(9_284_648n);
  });
  it("the app builds its growth view WITH the v2.2 depth rules now that the deployed wrapper applies them (wiring)", () => {
    const src = readFileSync(path.join(__dirname, "../../..", "hooks/useMarketLimits.ts"), "utf8");
    expect(src).toContain("isDevnetV22Enabled() && GROWTH_DEPTH_RULES_DEPLOYED");
    const gm = readFileSync(path.join(__dirname, "../../..", "lib/v21/growth-market.ts"), "utf8");
    expect(gm).toContain("export const GROWTH_DEPTH_RULES_DEPLOYED = true;");
  });
});

describe("1b. the second 40-lot long: the program says 92 because the account's equity is below the post-fill requirement", () => {
  it("the app predicts the same refusal and the same largest fill (within 0.001 lot of the simulated program)", () => {
    const g = jupAfterFill1();
    const r = growthGate({ view: g, direction: "long", takerEffQ: 40n * LOT, askQ: 40n * LOT, takerEquity: A_EQUITY, quoteFeeBps: QUOTE_BPS });
    expect(r.passes).toBe(false); // PROGRAM: Custom 92 on the 40-lot ask (clipped to 9.28)
    const diff = r.maxPassingQ > PROGRAM_MAX_SECOND_ASK_Q ? r.maxPassingQ - PROGRAM_MAX_SECOND_ASK_Q : PROGRAM_MAX_SECOND_ASK_Q - r.maxPassingQ;
    expect(diff).toBeLessThanOrEqual(1_000n);
    // the requirement at the clipped size is far above the equity: it would take about $250 more collateral
    expect(r.extraEquityNeeded).toBeGreaterThan(200_000_000n);
    expect(r.extraEquityNeeded).toBeLessThan(300_000_000n);
  });
  it("the ticket names the real fix (order up to X or add about $Y), not a '1x' leverage figure, and caps the size at X", () => {
    const g = jupAfterFill1();
    const t = deriveTicketLimits(input(g));
    expect(kinds(t)).toContain("growth-backing");
    expect(kinds(t)).not.toContain("growth-leverage");
    const m = t.issues.find((x) => x.kind === "growth-backing")!.message;
    expect(m).toMatch(/^Your collateral covers 64[45]\.\d+ JUP \(6\.4\d* lots\) on this side right now\. Order up to .*, or add about \$\d+ to fill 928\.4\d* JUP \(9\.2\d* lots\)\.$/);
    // this fixture's matcher quote carries no fee (the live fill paid 29 bps of quote), so its cap is a hair above the simulated program max
    expect(t.growthCapQ! > 6_440_000n && t.growthCapQ! < 6_460_000n).toBe(true);
  });
  it("the capped size passes the gate and one more q does not (the cap is exact), and the confirm dialog's post-trim leverage is below 1x", () => {
    const g = jupAfterFill1();
    const cap = growthFillCapQ({ view: g, direction: "long", takerEffQ: 40n * LOT, takerEquity: A_EQUITY, quoteFeeBps: QUOTE_BPS })!;
    const at = growthGate({ view: g, direction: "long", takerEffQ: 40n * LOT, askQ: cap, takerEquity: A_EQUITY, quoteFeeBps: QUOTE_BPS });
    const over = growthGate({ view: g, direction: "long", takerEffQ: 40n * LOT, askQ: cap + 1n, takerEquity: A_EQUITY, quoteFeeBps: QUOTE_BPS });
    expect(at.passes).toBe(true);
    expect(over.passes).toBe(false);
    // Risk Lev of the position after the trim: (40 + cap) lots * price / equity after fee < 1.1 (QA saw 1.7x for the untrimmed 80 lots)
    const notional = ((40n * LOT + cap) * PRICE) / LOT;
    expect(Number((notional * 1000n) / at.equityAtClip) / 1000).toBeLessThan(1.12);
  });
  it("a well-funded account (equity 1,700 USDC) is NOT refused: the program clips to the room and lands it", () => {
    const g = jupAfterFill1();
    const t = deriveTicketLimits(input(g, { takerEquity: 1_700_000_000n }));
    expect(kinds(t)).not.toContain("growth-backing");
    expect(kinds(t)).not.toContain("growth-leverage");
    expect(t.growthGate!.passes).toBe(true);
    expect(t.growthGate!.clipped).toBe(true);
    expect(t.growthCapQ).toBe(9_284_648n);
  });
  it("a bundled first-trade deposit (equity unknown to the ticket) keeps the slider check, as before", () => {
    const g = jupAfterFill1();
    const t = deriveTicketLimits(input(g, { takerEquity: null, leverage: 20 }));
    expect(t.growthGate).toBeNull();
    expect(kinds(t)).toContain("growth-leverage");
  });
  it("the 'Max leverage now' figure for this order is the one at the size that fills (1x at the room), not the marginal quote", () => {
    const g = jupAfterFill1();
    const t = deriveTicketLimits(input(g));
    expect(t.growth!.fillMaxLeverage).toBe(1); // u = 1 after the fill: dynamic IMR 100%
    expect(g.long.maxLeverageX100).toBeGreaterThan(100); // the marginal quote at the current OI is higher
  });
});

describe("2. swordcat: room below the minimum position leg = the side is full (Custom 113 after the clip)", () => {
  // price 34,166,515 per lot, band_min_leg_notional 100,000,000 -> ceil = 3 lots. users' long OI 21.747009, N_cap 29.091973, room 7.344964.
  const SWORD_PRICE = 34_166_515n;
  const MIN_LEG_Q = 3n * LOT;
  const N_CAP = 29_091_973n;
  const sword = (roomLeftQ: bigint) =>
    growthMarketView({
      raw: marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 }),
      engine: { ...ENGINE, effectivePriceE6: SWORD_PRICE, oiEffLongQ: N_CAP - roomLeftQ, oiEffShortQ: N_CAP - roomLeftQ },
      // C_m chosen so N_cap = 29,091,973 at this price
      lp: { capital: (N_CAP * SWORD_PRICE) / LOT + 1n, pnl: 0n, feeCredits: 0n },
      lpEffectiveQ: -(N_CAP - roomLeftQ),
      bound: true,
    })!;
  const t = (roomLeftQ: bigint, over: Partial<TicketLimitsInput> = {}) =>
    deriveTicketLimits({ limits: marketLimits(), direction: "long", sizeQ: 5n * LOT, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n, growth: sword(roomLeftQ), minLegQ: MIN_LEG_Q, takerEquity: 5_000_000_000n, format: fmt, ...over });
  it("the view's room is what was set up", () => {
    expect(sword(190_000n).long.headroomQ).toBe(190_000n);
  });
  it("room 0.19 lots (< 3-lot minimum): a flat taker cannot open, whatever the ask (program: 113 for 1 and 5 lots) -> paused", () => {
    const r = t(190_000n);
    expect(r.halted.long).toBe(true);
    expect(kinds(r)).toContain("growth-closed");
    expect(t(190_000n, { sizeQ: 1n * LOT }).halted.long).toBe(true);
  });
  it("room just under the minimum (2.99 lots) is full too; room at the minimum (3 lots) is not", () => {
    expect(t(2_990_000n).halted.long).toBe(true);
    expect(t(3_000_000n).halted.long).toBe(false);
    expect(t(7_344_964n).halted.long).toBe(false); // the live room: a 4-lot open lands (program control B1: OK)
  });
  it("a holder whose leg is already at or above the minimum may still add into a small room (the leg stays above the minimum)", () => {
    expect(t(190_000n, { takerPosQ: 4n * LOT, sizeQ: 1n * LOT }).halted.long).toBe(false);
  });
  it("a reduce or close is never paused by it", () => {
    expect(t(190_000n, { direction: "short", takerPosQ: 4n * LOT, sizeQ: 4n * LOT }).halted.short).toBe(false);
  });
});

describe("3. SOL room line has no lots suffix because SOL is lot_exp 0 (a token is a lot)", () => {
  it("lot_exp 0: tokens only; lot_exp 2: tokens and lots", () => {
    expect(sizeWithLots(8_173_273n, { lotExp: 0, ticker: "SOL" })).toBe("8.1732 SOL");
    expect(sizeWithLots(9_284_648n, { lotExp: 2, ticker: "JUP" })).toBe("928.4648 JUP (9.2846 lots)");
  });
});
