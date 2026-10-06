// @vitest-environment node
import { describe, it, expect } from "vitest";
import { decodeGrowthRecord, growthMarketView, growthTicketDecision, isReducingOrder, readBankruptcyHlockActive } from "@/lib/v21/growth-market";
import { dynImrBps, imrBpsForLeverageX100, ceilingImrBps, leverageX100ForImrBps } from "@/lib/v21/sdk";
import { ENGINE, LP, marketRaw } from "./fixtures";

const view = (over: { raw?: Uint8Array | null; engine?: Partial<typeof ENGINE>; lpQ?: bigint | null; bound?: boolean; lp?: typeof LP | null } = {}) =>
  growthMarketView({
    raw: over.raw === undefined ? marketRaw({}) : over.raw,
    engine: { ...ENGINE, ...over.engine },
    lp: over.lp === undefined ? LP : over.lp,
    lpEffectiveQ: over.lpQ === undefined ? -20_000_000n : over.lpQ,
    bound: over.bound ?? true,
  });

describe("feature detection: growth OFF reads as null on every market of today's programs", () => {
  it("an all-zero [672,792) record is OFF", () => {
    expect(decodeGrowthRecord(marketRaw(null))).toBeNull();
    expect(view({ raw: marketRaw(null) })).toBeNull();
  });
  it("short, foreign or missing bytes never throw and read as OFF", () => {
    expect(decodeGrowthRecord(new Uint8Array(100))).toBeNull();
    expect(decodeGrowthRecord(null)).toBeNull();
    const notMarket = marketRaw({});
    notMarket[10] = 2;
    expect(decodeGrowthRecord(notMarket)).toBeNull();
  });
  it("an ON record decodes the creator's launch cap and tier", () => {
    const g = decodeGrowthRecord(marketRaw({ launch: 550, tier: 1000, kink: 5000 }))!;
    expect(g.lLaunchX100).toBe(550);
    expect(g.lTierX100).toBe(1000);
    expect(g.kinkBps).toBe(5000);
  });
  it("no view until the LP is read (nothing is claimed from a half-loaded market)", () => {
    expect(view({ lp: null })).toBeNull();
    expect(view({ lpQ: null })).toBeNull();
  });
});

describe("live max leverage per side", () => {
  it("lightly used: both sides at the creator's launch cap (floor of 1e6/ceilingIMR)", () => {
    const v = view()!;
    const base = ceilingImrBps(1_000n, 550)!;
    expect(v.long.maxLeverageX100).toBe(Number(leverageX100ForImrBps(base)!)); // 549
    expect(v.short.maxLeverageX100).toBe(549);
    expect(v.long.crowd).toBe(true); // LP is short: longs join the crowd
    expect(v.short.crowd).toBe(false);
    expect(v.long.closed).toBe(false);
  });
  it("a filling crowd side steps down along the kinked curve; the thin side keeps the launch cap", () => {
    const v = view({ engine: { oiEffLongQ: 80_000_000n }, lpQ: -50_000_000n })!; // users long OI 80% of N_cap
    const base = ceilingImrBps(1_000n, 550)!;
    const dyn = dynImrBps(80_000_000n, 100_000_000n, base, 5_000n)!;
    expect(v.long.imrBps).toBe(dyn);
    expect(v.long.maxLeverageX100).toBe(Number(leverageX100ForImrBps(dyn)!));
    expect(v.long.maxLeverageX100).toBeLessThan(549);
    expect(v.short.maxLeverageX100).toBe(549);
    expect(v.long.utilizationBps).toBe(8_000n);
  });
  it("capacity scales with backing: more LP capital => higher cap at the same OI", () => {
    const crowded = { engine: { oiEffLongQ: 80_000_000n }, lpQ: -50_000_000n };
    const thin = view(crowded)!.long.maxLeverageX100;
    const backed = view({ ...crowded, lp: { ...LP, capital: 400_000_000n } })!.long.maxLeverageX100;
    expect(backed).toBeGreaterThan(thin);
  });
  it("a side at N_cap is closed (capacity-full); an unbound market is closed (not-bound); h-lock closes the crowd only", () => {
    const full = view({ engine: { oiEffLongQ: 100_000_000n }, lpQ: -50_000_000n })!;
    expect(full.long.closed).toBe(true);
    expect(full.long.closedReason).toBe("capacity-full");
    expect(view({ bound: false })!.long.closedReason).toBe("not-bound");
    const h = view({ raw: marketRaw({}, 3) })!; // attributed h-lock byte 1|1<<1
    expect(h.hlockActive).toBe(true);
    expect(h.long.closedReason).toBe("hlock");
    expect(h.short.closed).toBe(false);
  });
  it("graduation is compiled off: the ceiling is min(launch, tier)", () => {
    expect(view({ raw: marketRaw({ launch: 900, tier: 500 }) })!.short.maxLeverageX100).toBe(Number(leverageX100ForImrBps(imrBpsForLeverageX100(500)!)!));
  });
});

describe("h-lock byte is non-zero, not === 1 (P2b attributes it)", () => {
  it("0 off; 1 and 3 (attributed) on", () => {
    expect(readBankruptcyHlockActive(marketRaw({}, 0))).toBe(false);
    expect(readBankruptcyHlockActive(marketRaw({}, 1))).toBe(true);
    expect(readBankruptcyHlockActive(marketRaw({}, 3))).toBe(true);
    expect(readBankruptcyHlockActive(new Uint8Array(10))).toBe(false);
  });
});

describe("closes are never blocked", () => {
  it("isReducingOrder: reduce, close and flip", () => {
    expect(isReducingOrder(100n, "short", 40n)).toBe(true);
    expect(isReducingOrder(100n, "short", 100n)).toBe(true);
    expect(isReducingOrder(100n, "short", 150n)).toBe(false); // flip opens the other side
    expect(isReducingOrder(-100n, "long", 100n)).toBe(true);
    expect(isReducingOrder(100n, "long", 10n)).toBe(false); // adds
    expect(isReducingOrder(0n, "long", 10n)).toBe(false);
    expect(isReducingOrder(100n, "short", 0n)).toBe(false);
  });
  it("a closed side does not close a reducing order: no cap, no closed flag, no busy-side fee", () => {
    const full = view({ engine: { oiEffLongQ: 100_000_000n }, lpQ: -50_000_000n })!;
    const open = growthTicketDecision(full, "long", 0n, 10_000_000n);
    expect(open.closed).toBe(true);
    expect(open.maxLeverage).toBeNull();
    const close = growthTicketDecision(full, "long", -10_000_000n, 10_000_000n); // short 10 closing by buying
    expect(close.reducing).toBe(true);
    expect(close.closed).toBe(false);
    expect(close.fee).toBeNull();
  });
  it("an open into a busy side owes a utilisation fee; a thin-side open at low use owes none", () => {
    const busy = view({ engine: { oiEffLongQ: 60_000_000n }, lpQ: -50_000_000n })!;
    const d = growthTicketDecision(busy, "long", 0n, 20_000_000n);
    expect(d.fee!.utilFeeBps).toBeGreaterThan(0);
    expect(d.fee!.minSignedFeeBpsExMatcher).toBe(30n + BigInt(d.fee!.utilFeeBps));
    expect(growthTicketDecision(view()!, "short", 0n, 1_000_000n).fee!.utilFeeBps).toBe(0);
  });
});
