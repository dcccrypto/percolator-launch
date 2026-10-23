/**
 * QA retest (2026-10-14): LEV-8 (an over-capacity open is trimmed by the program, not refused by the ticket), the room line, a closed
 * side reading "paused", and the executed-size units on the REAL JUP / swordcat fills. JUP numbers: lot_exp 2, price 32.92 USDC per
 * lot, LP capital 1,440.25 USDC, lambda 1x => N_cap about 43.75 lots; users' long OI 40 lots.
 */
import "@testing-library/jest-dom";
import { PublicKey } from "@solana/web3.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrowthTicketPanel } from "@/components/trade/GrowthTicketPanel";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { growthFillForOrder, growthLeverageRefusal, growthMarketView, growthTicketDecision } from "@/lib/v21/growth-market";
import { clippedFillBody, clippedFillFromLogs } from "@/lib/v22/clipped-fill";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { roomLine, usdOfQ } from "@/lib/v22/growth-room";
import fx from "../../fixtures/v22-clipped-fill-tx.json";
import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { marketLimits, OWNER_A } from "../limits/fixtures";
import { ENGINE, marketRaw } from "../v21/fixtures";

beforeEach(() => __setDevnetV22ForTest(false));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const LOT = 1_000_000n;
const jup = (o: { usersLong?: bigint; usersShort?: bigint; hlock?: number; capital?: bigint } = {}) =>
  growthMarketView({
    raw: marketRaw({}, o.hlock ?? 0),
    engine: { ...ENGINE, effectivePriceE6: 32_920_000n, oiEffLongQ: o.usersLong ?? 40n * LOT, oiEffShortQ: o.usersShort ?? 0n },
    lp: { capital: o.capital ?? 1_440_250_000n, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: 0n,
    bound: true,
  })!;

const input = (g: ReturnType<typeof jup>, over: Partial<TicketLimitsInput> = {}): TicketLimitsInput => ({
  limits: marketLimits(), direction: "long", sizeQ: 40n * LOT, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n, growth: g, ...over,
});
const kinds = (t: ReturnType<typeof deriveTicketLimits>) => t.issues.map((x) => x.kind);

describe("LEV-8: the ticket judges the size that FILLS, not the ask", () => {
  it("the program's clip: ask 40 lots with 40 already on the side fills only the room (N_cap - users' OI)", () => {
    const g = jup();
    const f = growthFillForOrder(g, "long", 0n, 40n * LOT);
    expect(f.roomQ).toBe(g.long.nCapQ! - 40n * LOT);
    expect(f.roomQ! / 10_000n).toBe(375n); // ~3.75 lots of room at this capital
    expect(f.fillQ).toBe(f.roomQ);
    expect(f.trimmed).toBe(true);
    // the other side is separate: nothing there, so the whole ask fits
    const s = growthFillForOrder(g, "short", 0n, 40n * LOT);
    expect(s.trimmed).toBe(false);
    expect(s.fillQ).toBe(40n * LOT);
  });
  it("a close is never trimmed; a flip keeps its closing part and only the opening part is clipped", () => {
    const g = jup();
    expect(growthFillForOrder(g, "short", 10n * LOT, 10n * LOT).trimmed).toBe(false);
    const flip = growthFillForOrder(g, "long", -10n * LOT, 60n * LOT); // closes 10, opens 50 against ~3.75 of room
    expect(flip.fillQ).toBe(10n * LOT + flip.roomQ!);
    expect(flip.trimmed).toBe(true);
  });
  it("a second 40-lot long at 2x is NOT refused with the leverage copy: it is trimmed (it lands as a partial fill)", () => {
    const t = deriveTicketLimits(input(jup(), { leverage: 2 }));
    expect(kinds(t)).not.toContain("growth-leverage");
    expect(kinds(t)).not.toContain("growth-closed");
    expect(t.growth!.trimmed).toBe(true);
    expect(t.growth!.fillQ).toBe(t.growth!.roomQ);
  });
  it("only a genuinely over-leveraged FILL shows the leverage copy: the margin for the ask over the trimmed fill", () => {
    // 40-lot ask trimmed to ~3.75 lots; a 20x ticket puts 20 * 3.75 / 40 = 1.9x on the fill, above the 1x the program allows at N_cap.
    const t = deriveTicketLimits(input(jup(), { leverage: 20 }));
    expect(kinds(t)).toContain("growth-leverage");
    expect(growthLeverageRefusal(jup(), "long", 0n, 40n * LOT, 20)).toBe(1);
    expect(growthLeverageRefusal(jup(), "long", 0n, 40n * LOT, 2)).toBeNull();
  });
  it("an order that is NOT trimmed keeps the marginal cap as before (too much leverage at a size that fits is refused)", () => {
    const g = jup({ usersLong: 0n });
    const cap = growthTicketDecision(g, "long", 0n, 5n * LOT).maxLeverage!;
    expect(kinds(deriveTicketLimits(input(g, { sizeQ: 5n * LOT, leverage: cap + 1 })))).toContain("growth-leverage");
    expect(kinds(deriveTicketLimits(input(g, { sizeQ: 5n * LOT, leverage: Math.min(cap, 1) })))).not.toContain("growth-leverage");
  });
  it("a side with no room left (users' OI at N_cap) is still blocked as full, not trimmed to 0", () => {
    const g = jup();
    const full = jup({ usersLong: g.long.nCapQ! });
    const t = deriveTicketLimits(input(full));
    expect(kinds(t)).toContain("growth-closed");
  });
  it("the busy-side fee is quoted on the size that fills", () => {
    const g = jup();
    const d = growthTicketDecision(g, "long", 0n, 40n * LOT);
    expect(d.fee!.usersOiAfterQ).toBe(g.long.nCapQ);
  });
});

describe("room line and the panel", () => {
  const fmt = { lotExp: 2, ticker: "JUP" };
  it("room in tokens, lots and USD: 3.75 lots of JUP at 32.92 per lot", () => {
    expect(roomLine(3_750_000n, 32_920_000n, fmt)).toBe("Room on this side: 375 JUP (3.75 lots), about $123");
    expect(usdOfQ(1_000_000n, 32_920_000n)).toBe("$32.92");
  });
  it("renders the room, and the trim notice when the ask is bigger than the room", () => {
    const g = jup();
    render(<GrowthTicketPanel view={g} decision={growthTicketDecision(g, "long", 0n, 40n * LOT)} direction="long" sizeFormat={fmt} />);
    expect(screen.getByTestId("growth-room").textContent).toMatch(/^Room on this side: 37[0-9.]* JUP \(3\.7[0-9]* lots\), about \$12\d$/);
    expect(screen.getByTestId("growth-trim-notice").textContent).toMatch(/^Only .* of room left on this side; your order will fill /);
    expect(screen.getByTestId("growth-capacity-label").textContent).toMatch(/% full$/);
  });
  it("no trim notice when the order fits; long and short rooms are separate", () => {
    const g = jup();
    render(<GrowthTicketPanel view={g} decision={growthTicketDecision(g, "short", 0n, 1n * LOT)} direction="short" sizeFormat={fmt} />);
    expect(screen.queryByTestId("growth-trim-notice")).toBeNull();
    expect(screen.getByTestId("growth-room").textContent).toContain("4,375 JUP (43.75 lots)");
  });
  it("a closed side reads 'paused' in the capacity row, never '0% full' (h-lock: closed with 0 open interest)", () => {
    const g = jup({ usersLong: 0n, hlock: 3 });
    expect(g.long.closedReason).toBe("hlock");
    expect(g.long.utilizationBps).toBe(0n); // the number that used to print "0% full"
    render(<GrowthTicketPanel view={g} decision={growthTicketDecision(g, "long", 0n, 1n * LOT)} direction="long" sizeFormat={fmt} />);
    expect(screen.getByTestId("growth-capacity-label")).toHaveTextContent("paused");
    expect(screen.queryByText(/% full/)).toBeNull();
    expect(screen.queryByTestId("growth-room")).toBeNull();
  });
  it("a side the ticket pauses for another reason (P1 halted) also reads 'paused', not a percentage", () => {
    const g = jup();
    render(<GrowthTicketPanel view={g} decision={growthTicketDecision(g, "long", 0n, 1n * LOT)} direction="long" sizeFormat={fmt} sidePaused />);
    expect(screen.getByTestId("growth-capacity-label")).toHaveTextContent("paused");
    expect(screen.queryByTestId("growth-room")).toBeNull();
  });
  it("a holder composing a reduce on a closed side sees 'paused' for that side's capacity, not 0%", () => {
    const g = jup({ usersLong: 0n, hlock: 3 });
    render(<GrowthTicketPanel view={g} decision={growthTicketDecision(g, "long", -5n * LOT, 1n * LOT)} direction="long" sizeFormat={fmt} />);
    expect(screen.getByTestId("growth-capacity-label")).toHaveTextContent("paused");
  });
});

describe("executed size units on the real fills (tokens = lots x 10^lot_exp; lots shown too)", () => {
  const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
  const JUP = new PublicKey("GtUe5hYy8scuMsp2cmXt7WfCfqKVgTJ8RjuTyvz3MB8B");
  const SWORDCAT = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");
  it("JUP 2angD8qZ… (lot_exp 2): requested 40,000,000 q, executed 3,130,361 q = 3.1303 of 40 lots = 313.0361 of 4,000 JUP", () => {
    const logs = fillEventLogs(WRAPPER, JUP, [{ flags: 9, requestedQ: 40_000_000n, executedQ: 3_130_361n }]);
    const cf = clippedFillFromLogs(logs, WRAPPER, { market: JUP })!;
    expect(clippedFillBody(cf, 2, "JUP")).toBe("Partially filled: 313.0361 of 4,000 JUP (3.1303 of 40 lots). The market had room for part of your order.");
  });
  it("swordcat 4gyLCVZG… (lot_exp 4), the real transaction: executed 9,525,082 q = 9.525 lots = 95,250.82 tokens", () => {
    const cf = clippedFillFromLogs(fx.logMessages, WRAPPER, { market: SWORDCAT })!;
    expect(clippedFillBody(cf, 4, "SWORD")).toBe("Partially filled: 95,250.82 of 100,000 SWORD (9.525 of 10 lots). The market had room for part of your order.");
  });
  it("a market without lots (lot_exp 0) reads exactly as before, no lots clause", () => {
    expect(clippedFillBody({ requestedQ: 10_000_000n, executedQ: 9_525_082n, zero: false }, 0, "SOL")).toBe(
      "Partially filled: 9.525 of 10 SOL. The market had room for part of your order.",
    );
  });
});
