/**
 * r8 Council (#3807): the room / equity / guard caps are derived whatever size is typed, but the ORDER-specific checks (growth gate, guard
 * refusal, band halt) skip a pure reduce and still apply to a flip. A reduce can always close the whole position: no guard cap sits below it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { balanceMaxQ, buyingPowerAtoms, oneMaxQ } from "@/lib/limits/ticket-state";
import { growthMarketView, type GrowthMarketView } from "@/lib/v21/growth-market";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { LevGuardOpenInputV22, LevGuardOpenLimitsV22 } from "@/lib/v22/sdk/lev-guard-limits-v22";
import { marketLimits, OWNER_A } from "./fixtures";
import { marketRaw } from "../v21/fixtures";

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const LOT = 1_000_000n;
const PRICE = 1_000_000n;
const base = (): GrowthMarketView =>
  growthMarketView({
    raw: marketRaw({ launch: 800, tier: 800, ceil: 800, kink: 5000, lambda: 10_000 }),
    engine: { initialMarginBps: 1_000n, effectivePriceE6: PRICE, oiEffLongQ: 600n * LOT, oiEffShortQ: 600n * LOT, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
    lp: { capital: 950_000_000n, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: -600n * LOT,
    bound: true,
  })!;

const limitsOf = (over: Partial<LevGuardOpenLimitsV22>): LevGuardOpenLimitsV22 => ({
  applies: true, blocked: null, opensAtSlot: null, band: null, roundLive: false, overlay: null, lEffX100: 1_000, imrBps: 1_000n, nEffQ: 0n, lpAbsMaxQ: 0n, frozen: false, mOracle: false, ...over,
});
const withGuard = (lim: Partial<LevGuardOpenLimitsV22>, lpEffQ: bigint): GrowthMarketView => ({
  ...base(),
  guard: { limits: limitsOf(lim), input: { lpEffQ, priceE6: PRICE } as unknown as LevGuardOpenInputV22 },
});

const POS = 5_000n; // a long of 5,000 q; the ticket is on the SHORT side, so a short <= 5,000 only reduces
const input = (growth: GrowthMarketView, sizeQ: bigint, over: Partial<TicketLimitsInput> = {}): TicketLimitsInput => ({
  limits: marketLimits({ matcher: null }), direction: "short", sizeQ, takerPosQ: POS, takerOwner: OWNER_A, leverage: 5, limitPriceE6: 0n,
  growth, takerEquity: 1_000_000_000_000n, format: { size: (q) => `${q}q`, collateral: (a) => `${a}` }, ...over,
});
const kinds = (t: ReturnType<typeof deriveTicketLimits>) => t.issues.map((i) => i.kind);

describe("a guard-bound reduce can always close the full position", () => {
  // n_mult-style cap: the guard admits a 3,000 q fill, the position is 5,000 q
  it("guard fill cap (3,000 q) below the position (5,000 q): the cap is floored at the close, never below it", () => {
    const g = withGuard({ lpAbsMaxQ: 10_000n, nEffQ: 10_000n }, 7_000n);
    for (const sizeQ of [0n, 1_000n, POS]) {
      const t = deriveTicketLimits(input(g, sizeQ));
      expect(t.growthCapQ, `size ${sizeQ}`).not.toBeNull();
      expect(t.growthCapQ! >= POS, `cap ${t.growthCapQ} at size ${sizeQ}`).toBe(true);
      expect(t.growthCapQ! <= POS + (g.short.headroomQ ?? 0n)).toBe(true);
    }
  });
  it("W1 round active (fill cap 0): Max is the full close, not 0", () => {
    const g = withGuard({ roundLive: true, lpAbsMaxQ: 7_000n, nEffQ: 7_000n }, 7_000n);
    const t = deriveTicketLimits(input(g, 1_000n));
    expect(t.growthCapQ).toBe(POS);
    const maxQ = oneMaxQ([t.growthCapQ, balanceMaxQ(1_000_000_000n, 5, PRICE)]);
    expect(maxQ).toBe(POS);
  });
  it("LOW-2: a guard-bound reduce is not labelled market room", () => {
    for (const [lim, lp] of [[{ lpAbsMaxQ: 10_000n, nEffQ: 10_000n }, 7_000n], [{ roundLive: true, lpAbsMaxQ: 7_000n, nEffQ: 7_000n }, 7_000n]] as const) {
      const g = withGuard(lim, lp);
      const t = deriveTicketLimits(input(g, 1_000n));
      const marketMaxQ = oneMaxQ([t.growthCapQ]);
      const bp = buyingPowerAtoms({ tradableAtoms: 1_000_000_000_000n, leverage: 5, marketMaxQ, roomMaxQ: oneMaxQ([t.growthRoomQ]), priceE6: PRICE })!;
      expect(bp.capped).toBe(false);
    }
  });
  it("the guard still bounds the OPENING part beyond the close", () => {
    // fill cap 6,000 q > the 5,000 close: the cap stays 6,000 (close + 1,000 of opening room is NOT added: the fill cap is the bound)
    const g = withGuard({ lpAbsMaxQ: 13_000n, nEffQ: 13_000n }, 7_000n);
    const t = deriveTicketLimits(input(g, 0n));
    expect(t.growthCapQ).toBe(6_000n);
    expect(t.growthRoomQ).toBe(6_000n);
  });
});

describe("the order-specific checks skip a pure reduce and still apply to a flip", () => {
  it("growth gate (growth-backing): skipped for a reduce, raised for a flip", () => {
    const g = base();
    const poor = { takerEquity: 1n, maxEquity: null };
    expect(kinds(deriveTicketLimits(input(g, 1_000n, poor)))).not.toContain("growth-backing");
    expect(deriveTicketLimits(input(g, 1_000n, poor)).growthGate).toBeNull();
    const flip = deriveTicketLimits(input(g, 900n * LOT, { ...poor, takerPosQ: POS }));
    expect(kinds(flip)).toContain("growth-backing");
  });
  it("guard refusal (lev-guard): skipped for a reduce, raised for a flip", () => {
    const g = withGuard({ lpAbsMaxQ: 8_000n, nEffQ: 8_000n }, 7_000n);
    expect(kinds(deriveTicketLimits(input(g, 4_000n)))).not.toContain("lev-guard");
    expect(kinds(deriveTicketLimits(input(g, 9_000n)))).toContain("lev-guard");
  });
  it("band halt (growth-closed / side full): a reduce never halts; a flat add still does", () => {
    // growthSideHalt already returns null whenever the order has a closing part (reduce AND flip), so `!growth.reducing` on that line is
    // redundant by construction; what is pinned here is the behaviour: a reduce never reads the side as full, a flat taker's add still does.
    const g = base();
    const band = { minLegQ: 1_000_000_000_000_000n };
    const red = deriveTicketLimits(input(g, 1_000n, band));
    expect(kinds(red)).not.toContain("growth-closed");
    expect(red.halted.short).toBe(false);
    const flat = deriveTicketLimits(input(g, 900n * LOT, { ...band, takerPosQ: 0n }));
    expect(kinds(flat)).toContain("growth-closed");
    expect(flat.halted.short).toBe(true);
  });
});
