// @vitest-environment node
/**
 * r8 BUG B: with a position already open, Buying power and Max FELL as leverage rose (live preview, $20 SOL short open:
 * 1,252.93 at 1x-5x, 87.17 at 10x).
 *
 * Root cause: the growth cap on the Max reads the account's equity, and the ticket supplied that equity (`takerEquity`) only when the order
 * bundles NO deposit (`!fundingMode`). Whether a deposit is bundled depends on size / leverage (a lower leverage needs more margin), so the
 * Max switched formula part-way along the slider: room only while a deposit was needed (1x-5x), the account's own thin equity once it was not
 * (10x). The fix is an order-independent `maxEquity` (equity plus what the wallet could deposit).
 *
 * This test drives the same pipeline the ticket runs (deriveTicketLimits -> oneMaxQ -> buyingPowerAtoms) over 1x..10x.
 */
import { describe, expect, it } from "vitest";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { balanceMaxQ, buyingPowerAtoms, oneMaxQ } from "@/lib/limits/ticket-state";
import { fundDepositAtoms, maxWalletDepositAtoms, tradableMarginAtoms } from "@/lib/first-trade";
import { growthDepositFloorAtoms, growthGate } from "@/lib/v22/growth-gate";
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

const WALLET = 10_000n * 1_000_000n;
const LEVS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

interface Scenario { capital: bigint; takerPosQ: bigint; sizeQ: bigint; wallet: bigint }

/** The ticket's Max + Buying power at `lev`, with or without the fix. */
function pipeline(s: Scenario, lev: number, fixed: boolean) {
  const available = s.capital; // locked margin of the small position ignored: the test is about the shape across leverage
  const tradable = tradableMarginAtoms({ inMarketAvailable: available, walletAtoms: s.wallet, leverage100: lev * 100, feeBps: 30n, initialMarginBps: 1000n, decimals: 6 });
  // fundingMode: the order's margin does not fit the in-market balance
  const marginNeed = s.sizeQ > 0n ? (s.sizeQ * PRICE) / 1_000_000n / BigInt(lev) : 0n;
  const fundingMode = marginNeed > available && s.wallet > 0n;
  const equityNow = s.capital;
  const input: TicketLimitsInput = {
    limits: marketLimits({ matcher: null }), direction: "short", sizeQ: s.sizeQ, takerPosQ: s.takerPosQ, takerOwner: OWNER_A, leverage: lev, limitPriceE6: 0n,
    growth: view(),
    takerEquity: !fundingMode ? equityNow : null,
    ...(fixed ? { maxEquity: equityNow + maxWalletDepositAtoms(s.wallet) } : {}),
  };
  const t = deriveTicketLimits(input);
  const marketMaxQ = oneMaxQ([t.sideLimits?.short?.maxQ, t.growthCapQ]);
  const roomQ = oneMaxQ([t.sideLimits?.short?.maxQ, t.growthRoomQ]);
  const maxQ = oneMaxQ([marketMaxQ, balanceMaxQ(tradable, lev, PRICE)]);
  const bp = buyingPowerAtoms({ tradableAtoms: tradable, leverage: lev, marketMaxQ, roomMaxQ: roomQ, priceE6: PRICE });
  return { maxQ, bp, fundingMode };
}

const scenarios: Array<[string, Scenario]> = [
  ["position open, size empty", { capital: 12_000_000n, takerPosQ: -(610_000n), sizeQ: 0n, wallet: WALLET }],
  ["position open, size filled (deposit needed at low leverage)", { capital: 12_000_000n, takerPosQ: -(610_000n), sizeQ: 3n * LOT, wallet: WALLET }],
  ["position open, small size (no deposit at any leverage)", { capital: 12_000_000n, takerPosQ: -(610_000n), sizeQ: 20_000n, wallet: WALLET }],
  ["position open, no wallet funds", { capital: 12_000_000n, takerPosQ: -(610_000n), sizeQ: 3n * LOT, wallet: 0n }],
  ["no position, size filled", { capital: 12_000_000n, takerPosQ: 0n, sizeQ: 3n * LOT, wallet: WALLET }],
];

describe("r8 BUG B: Buying power and Max never fall as leverage rises", () => {
  for (const [name, s] of scenarios) {
    it(`${name}: monotonic non-decreasing across 1x..10x`, () => {
      const rows = LEVS.map((l) => pipeline(s, l, true));
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].bp!.atoms >= rows[i - 1].bp!.atoms, `bp at ${LEVS[i]}x`).toBe(true);
        expect((rows[i].maxQ ?? 0n) >= (rows[i - 1].maxQ ?? 0n), `max at ${LEVS[i]}x`).toBe(true);
      }
    });
  }

  it("covers both deposit-needed and not within the sweep", () => {
    const rows = LEVS.map((l) => pipeline(scenarios[1][1], l, true));
    expect(rows.some((r) => r.fundingMode)).toBe(true);
    expect(rows.some((r) => !r.fundingMode)).toBe(true);
  });

  it("reproduces the bug without the fix (Max switches formula where the deposit stops being needed)", () => {
    const s = scenarios[1][1];
    const old = LEVS.map((l) => pipeline(s, l, false).bp!.atoms);
    expect(old.some((v, i) => i > 0 && v < old[i - 1])).toBe(true);
  });

  it("with the fix the figure never exceeds the account's equity-bound opening room", () => {
    const s = scenarios[1][1];
    for (const l of LEVS) {
      const r = pipeline(s, l, true);
      const t = deriveTicketLimits({
        limits: marketLimits({ matcher: null }), direction: "short", sizeQ: 0n, takerPosQ: s.takerPosQ, takerOwner: OWNER_A, leverage: l, limitPriceE6: 0n,
        growth: view(), takerEquity: null, maxEquity: s.capital + maxWalletDepositAtoms(s.wallet),
      });
      expect(r.maxQ! <= (t.growthCapQ ?? r.maxQ!)).toBe(true);
    }
  });

  it("the room label is true only when room binds, not when the account's equity does", () => {
    const eq = (tradable: bigint, marketMaxQ: bigint, roomMaxQ: bigint | null) =>
      buyingPowerAtoms({ tradableAtoms: tradable, leverage: 5, marketMaxQ, roomMaxQ, priceE6: PRICE })!;
    // an equity bound (marketMaxQ) tighter than the room: not "market room"
    expect(eq(1_000_000_000n, 2n * LOT, 50n * LOT).capped).toBe(false);
    // room is what binds
    expect(eq(1_000_000_000n, 2n * LOT, 2n * LOT).capped).toBe(true);
    // nothing binds
    expect(eq(1_000_000n, 5n * LOT, 5n * LOT).capped).toBe(false);
  });
});

describe("r8 MED-1: a submit at Max passes the growth gate at every leverage (with the deposit the ticket bundles)", () => {
  const FEE_BPS = 30n;
  /** The ticket's bundled deposit for an order of `askQ`: max(gate shortfall, margin shortfall) + fee, as OrderTicket computes it (fundDepositAtoms). */
  function submitAt(s: Scenario, lev: number, askQ: bigint) {
    const equityNow = s.capital;
    const notional = (askQ * PRICE) / 1_000_000n;
    const fundFee = (notional * FEE_BPS) / 10_000n;
    const marginNeed = notional / BigInt(lev);
    const marginShortEngine = marginNeed > s.capital ? marginNeed - s.capital : 0n;
    const floor = growthDepositFloorAtoms({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ, equityNow, fundFee });
    const gateNeedsDeposit = !growthGate({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ, takerEquity: equityNow }).passes;
    const fundingMode = s.wallet > 0n && (marginShortEngine > 0n || gateNeedsDeposit);
    const marginShort = floor > marginShortEngine ? floor : marginShortEngine;
    const deposit = fundingMode ? fundDepositAtoms(marginShort, fundFee, s.wallet, 6) : 0n;
    const gate = growthGate({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ, takerEquity: equityNow + deposit, quoteFeeBps: 0n });
    return { deposit, fundingMode, gate };
  }
  const walletScenarios: Array<[string, Scenario]> = [
    ["wallet 10,000", { capital: 12_000_000n, takerPosQ: -610_000n, sizeQ: 0n, wallet: WALLET }],
    ["wallet 300", { capital: 12_000_000n, takerPosQ: -610_000n, sizeQ: 0n, wallet: 300_000_000n }],
    ["wallet 50", { capital: 12_000_000n, takerPosQ: -610_000n, sizeQ: 0n, wallet: 50_000_000n }],
    ["no position, wallet 300", { capital: 12_000_000n, takerPosQ: 0n, sizeQ: 0n, wallet: 300_000_000n }],
  ];
  for (const [name, s] of walletScenarios) {
    it(`${name}: Max passes the gate with its own deposit at 1x..10x, the deposit fits the wallet, and Max stays monotonic`, () => {
      let prev = 0n;
      let sawDeposit = false;
      for (const l of LEVS) {
        const maxQ = pipeline(s, l, true).maxQ ?? 0n;
        expect(maxQ >= prev, `max at ${l}x`).toBe(true);
        prev = maxQ;
        if (maxQ === 0n) continue;
        const r = submitAt(s, l, maxQ);
        sawDeposit ||= r.fundingMode;
        expect(r.deposit <= s.wallet, `deposit fits the wallet at ${l}x`).toBe(true);
        expect(r.gate.passes, `gate at Max ${maxQ} / ${l}x (deposit ${r.deposit})`).toBe(true);
      }
      expect(sawDeposit).toBe(true);
    });
  }
  it("without the gate-shortfall deposit the same Max is refused at high leverage (the reviewer's repro)", () => {
    const s = walletScenarios[0][1];
    const maxQ = pipeline(s, 10, true).maxQ!;
    const notional = (maxQ * PRICE) / 1_000_000n;
    const marginOnly = notional / 10n + (notional * FEE_BPS) / 10_000n;
    expect(growthGate({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ: maxQ, takerEquity: s.capital + marginOnly }).passes).toBe(false);
  });
});

describe("r8 (review of #3804, LOW-B / LOW-C): the bundled deposit is exactly the gate's need and never overshoots the wallet at Max", () => {
  it("floor + the ticket fee = the gate's extraEquityNeeded, whatever the ticket fee is (so a deposit at Max fits capital + wallet)", () => {
    const s = { capital: 12_000_000n, takerPosQ: -610_000n };
    for (const fundFee of [0n, 50_000n, 400_000n, 5_000_000n]) {
      for (const quoteFeeBps of [0n, 25n]) {
        const askQ = 20n * LOT;
        const g = growthGate({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ, takerEquity: s.capital, quoteFeeBps });
        const floor = growthDepositFloorAtoms({ view: view(), direction: "short", takerEffQ: s.takerPosQ, askQ, equityNow: s.capital, fundFee, quoteFeeBps });
        expect(g.extraEquityNeeded > 0n).toBe(true);
        expect(floor + (g.extraEquityNeeded > fundFee ? fundFee : g.extraEquityNeeded)).toBe(g.extraEquityNeeded);
      }
    }
  });
  it("the matcher's quote fee raises the need (so the deposit gate must use the same quote fee as the Max cap)", () => {
    const a = growthGate({ view: view(), direction: "short", takerEffQ: -610_000n, askQ: 20n * LOT, takerEquity: 12_000_000n, quoteFeeBps: 0n });
    const b = growthGate({ view: view(), direction: "short", takerEffQ: -610_000n, askQ: 20n * LOT, takerEquity: 12_000_000n, quoteFeeBps: 50n });
    expect(b.extraEquityNeeded > a.extraEquityNeeded).toBe(true);
  });
});

