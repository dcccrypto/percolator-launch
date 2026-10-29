/**
 * #3553 on v2.2: Max at the market's max leverage was refused Custom(49) (EngineInsufficientInitialMargin) on a market that charges the
 * matcher's quote fee. The program charges the WHOLE fee (base + quote + busy-side) before its IM gate (percolator-prog v16_program.rs
 * handle_trade_cpi: `fee_bps = base_fee_bps + lp_requested_fee_bps`), but the ticket's gate sizing (#3554) knew only the base fee, so at a
 * leverage where IM x leverage = 100% (10x at IMR 10%) the margin it offered left equity short by the quote fee.
 */
import { describe, expect, it } from "vitest";
import { engineOpenNeedAtoms, tradableMarginAtoms } from "@/lib/first-trade";
import { gateFeeBps, estimatedTotalFeeBps } from "@/lib/limits/estimated-fee";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { ALL_ON, OWNER_A, marketLimits } from "./fixtures";

const USD = 1_000_000n;
// The P2 fee channel on: the matcher's quote above the mark is charged as `requested_fee_bps` on top of the base fee.
// A kind-1 matcher quotes no exact price, so the ticket signs (and the estimate uses) its price bound: 60 bps here.
const base0 = marketLimits();
const charged = marketLimits({
  matcher: { ...base0.matcher!, kind: 1, v2: undefined, maxTotalBps: 60 },
  flags: { ...ALL_ON, p2FeeCharged: true },
  riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: 1, maxRequestedFeeBps: 100, allDefault: false },
});
const uncharged = marketLimits();
const input = (limits = charged, sizeQ = 50n * USD): TicketLimitsInput => ({
  limits, direction: "long", sizeQ, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 10, limitPriceE6: 0n, takerEquity: null,
});

describe("gateFeeBps", () => {
  it("charged quote fee: the base fee plus the matcher's quote fee, the same estimate the Fee row shows", () => {
    const t = deriveTicketLimits(input());
    expect(t.fee?.charged).toBe(true);
    expect(t.fee!.requestedBps).toBe(60n);
    const total = gateFeeBps(10n, input());
    expect(total).toBe(estimatedTotalFeeBps(10n, t.fee));
    expect(total).toBe(70n);
  });
  it("CONTROL: a market that does not charge the quote adds nothing; no size or no input is the base fee", () => {
    expect(gateFeeBps(10n, input(uncharged))).toBe(10n);
    expect(gateFeeBps(10n, input(charged, 0n))).toBe(10n);
    expect(gateFeeBps(10n, null)).toBe(10n);
  });
});

describe("Max at max leverage clears the engine's gate once the whole fee is in the sizing", () => {
  const A = 100n * USD;
  const IM = 1_000n; // 10x
  const max = (feeBps: bigint) => tradableMarginAtoms({ inMarketAvailable: A, walletAtoms: 0n, leverage100: 1_000, feeBps, initialMarginBps: IM });
  // The engine: fee first, then equity must cover the IM on the notional (no price gap here: r = 1, no lag).
  const engineAccepts = (margin: bigint, chargedFeeBps: bigint) => {
    const notional = margin * 10n;
    const need = engineOpenNeedAtoms(notional, IM, chargedFeeBps);
    return need.im + need.fee <= A;
  };
  const total = gateFeeBps(10n, input());
  it("sized on the base fee alone (the old ticket) the order is refused: equity after the real fee is below IM", () => {
    expect(engineAccepts(max(10n), total)).toBe(false); // Custom(49)
  });
  it("sized on the whole fee the same order is accepted, and still uses almost all of the free capital", () => {
    const m = max(total);
    expect(engineAccepts(m, total)).toBe(true);
    expect(m).toBeGreaterThan((A * 90n) / 100n);
  });
  it("CONTROL: the base fee IS the whole fee when nothing extra is charged, so nothing changes", () => {
    expect(max(gateFeeBps(10n, input(uncharged)))).toBe(max(10n));
    expect(engineAccepts(max(10n), 10n)).toBe(true);
  });
});
