/**
 * App bug 2026-10-29 (product review findings 4 / 5, R2): the order ticket's max leverage, slider, room and Max ignored the v2.2
 * leverage guard (tag 124) and rc23's two capacity caps (κ fee cap #594, λ ≤ 1.0 / λ_vol #599). The ticket now quotes the tightest of
 * every limit percolator-prog feat/v22-rc23-2026-10-22 @ 02524b05 enforces on an open, so it never promises more than the program allows.
 * The pure rules are the SDK port (percolator-sdk fix/v22-sdk-rc23-open-limits, parity with the program's own functions); these tests pin
 * the APP wiring: growth view -> side quotes -> deriveTicketLimits (Max / clamp, issues) -> what the ticket shows.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioLegs, decodePortfolioRisk } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { growthFor } from "@/hooks/useMarketLimits";
import { __setRc23OpenLimitsForTest, growthMarketView, type GrowthMarketView } from "@/lib/v21/growth-market";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ASSET_GROWTH_FIELD_OFF } from "@/lib/v22/sdk/records/growth-v19";
import type { LevGuardV22 } from "@/lib/v22/sdk";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { marketRaw } from "../v21/fixtures";
import { marketLimits, OWNER_A } from "../limits/fixtures";

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setRc23OpenLimitsForTest(true);
});
afterEach(() => {
  __setDevnetV22ForTest(null);
  __setRc23OpenLimitsForTest(null);
});

const USD = 1_000_000n;
const DAY = 216_000n;
const T0 = 1_000_000n;

// ── 1. rc23 κ cap on REAL devnet bytes (CHILLHOUSE-T, tier 0, read 2026-10-17 slot 512136545) ───────────────────────────────────────
const DIR = path.join(__dirname, "../../fixtures/v22-growth");
const load = (n: string): Uint8Array => new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(DIR, n), "utf8")) as { data: string }).data, "base64"));
const SLOT = 512_136_545n;
function chillhouse() {
  const raw = load("chillhouse-t.market.json");
  const lpBytes = load("chillhouse-t.lp.json");
  const engine = decodeMarketEngineView(raw, 0)!;
  const risk = decodePortfolioRisk(lpBytes)!;
  const vaultLp = decodeAssetVaultLp(raw, 0);
  const lpQ = lpEffectiveSignedQ(lpBytes, engine, 0, engine.marketId);
  const lp = { ...risk, address: new PublicKey(vaultLp?.vaultLpPortfolio ?? new Uint8Array(32)), posQ: 0n, legs: decodePortfolioLegs(lpBytes) };
  return { raw, engine, vaultLp, lpQ, lp };
}

describe("rc23 κ cap: the ticket's room on a depth-capped market (real CHILLHOUSE-T bytes)", () => {
  const view = (): GrowthMarketView => {
    const i = chillhouse();
    return growthFor({ engine: i.engine, vaultLp: i.vaultLp }, { lp: i.lp }, i.lpQ, i.raw, 0, SLOT)!;
  };
  it("N_cap = floor(capDepth · 253 bps) / P, not the old κ 0.5 (10,250 q): ~19.8x less room", () => {
    const v = view();
    const price = chillhouse().engine.effectivePriceE6;
    const want = ((v.long.capDepthE6! * 253n) / 10_000n) * 1_000_000n / price;
    expect(v.long.nCapQ).toBe(want);
    expect(v.long.headroomQ).toBe(want);
    expect(v.long.nCapQ! < 10_250n).toBe(true);
    __setRc23OpenLimitsForTest(false);
    expect(view().long.nCapQ).toBe(10_250n); // the pre-rc23 wrapper's number (growth-depth-real-bytes.test.ts)
  });
  it("the ticket's Max (growthCapQ) is that smaller room", () => {
    const v = view();
    const t = deriveTicketLimits({
      limits: marketLimits(), direction: "long", sizeQ: 0n, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n,
      growth: v, takerEquity: 1_000n * USD,
    });
    expect(t.growthCapQ).not.toBeNull();
    expect(t.growthCapQ! <= v.long.headroomQ!).toBe(true);
  });
  it("no guard bit and no guard account (devnet today): the guard changes nothing", () => {
    const v = view();
    expect(v.guard).toBeNull(); // not read -> not quoted
    const i = chillhouse();
    const withRead = growthFor({ engine: i.engine, vaultLp: i.vaultLp }, { lp: i.lp, guard: { account: null } }, i.lpQ, i.raw, 0, SLOT)!;
    expect(withRead.guard?.limits.applies).toBe(false);
    expect(withRead.long).toEqual(v.long);
    expect(withRead.short).toEqual(v.short);
  });
});

// ── 2. rc23 λ cap (λ ≤ 1.0 before W1) on the P1 LP cap and the vault-LP cap ─────────────────────────────────────────────────────────
describe("rc23 λ cap: the quote's λ_eff feeds the P1 LP cap", () => {
  it("a 3x stored λ is read as 1x: λ_eff and N_cap follow (prog #599)", async () => {
    const { quoteMaxLeverage, decodeAssetGrowthRecordV19, ASSET_GROWTH_LEN, DEPTH_EVER, DEPTH_PREV_REAL, DEPTH_SOURCE } = await import("@/lib/v22/sdk/records/growth-v19");
    const b = new Uint8Array(ASSET_GROWTH_LEN);
    const dv = new DataView(b.buffer);
    dv.setUint16(20, 500, true); dv.setUint16(22, 2_000, true); dv.setUint16(24, 2_000, true); dv.setUint32(16, 30_000, true); dv.setUint16(28, 3445, true);
    b[38] = 1; b[39] = 1; b[44] = DEPTH_EVER | DEPTH_PREV_REAL | DEPTH_SOURCE.OnChainPool;
    // pool depth $100M (tier 3): the κ depth cap (2.53% = $2.53M) is far above the capital rule
    dv.setBigUint64(56, 100_000_000n * USD, true); dv.setBigUint64(64, 990n, true); dv.setBigUint64(72, 100_000_000n * USD, true);
    dv.setBigUint64(80, 100_000_000n * USD, true); dv.setBigUint64(88, 990n, true);
    const g = decodeAssetGrowthRecordV19(b)!;
    const q = (rc23Caps: boolean) => quoteMaxLeverage({
      engineImrBps: 500n, growth: g, lpCapital: 1_000_000n * USD, lpPnl: 0n, lpFeeCredits: 0n, lpEffectivePositionQ: 0n, assetBound: true,
      oiEffLongQ: 0n, oiEffShortQ: 0n, priceE6: 1_000_000n, bankruptcyHlockActive: false,
      v22: { bandBps: 1000, nowSlot: 1_000n, vol: { liquidationFeeBps: 50n, bandMaxEpochSlots: 600n }, rc23Caps },
    }, "long");
    // C_m $1M at λ 3x (book depth $3M, tier 3): pre-rc23 λ_eff = the curve's λ_depth (> 1x); rc23 caps λ at 1.0 -> $1M (below κ's $2.53M).
    const pre = q(false);
    expect(pre.lambdaEffBps!).toBeGreaterThan(10_000); // the lagging curve's λ_depth above 1x
    expect(pre.nCapQ).toBe((1_000_000n * USD * BigInt(pre.lambdaEffBps!)) / 10_000n);
    expect(q(true).lambdaEffBps).toBe(10_000);
    expect(q(true).nCapQ).toBe(1_000_000n * USD);
  });
});

describe("the P1 LP cap (68) reads λ_eff, not the stored λ (growth_capacity_lambda_view)", () => {
  it("a lower λ_eff lowers the P1 side limit the ticket shows", () => {
    const g = guarded({ bit: false, account: null });
    const withEff = (bps: number): GrowthMarketView => ({ ...g, long: { ...g.long, lambdaEffBps: bps }, short: { ...g.short, lambdaEffBps: bps } });
    // A flat LP with $100 equity: the P1 cap is k · equity / P (k = λ_eff on a growth asset).
    const base = marketLimits();
    const limits = marketLimits({ lp: { ...base.lp!, posQ: 0n } });
    const at = (v: GrowthMarketView) => ticket(v, { limits }).sideLimits!.long;
    expect(at(withEff(10_000))).toMatchObject({ maxQ: 100n * USD, reason: "lp-exposure" });
    expect(at(withEff(5_000))).toMatchObject({ maxQ: 50n * USD, reason: "lp-exposure" });
  });
});

// ── 3. the guard, through the app's growth view and ticket ─────────────────────────────────────────────────────────────────────────
const MARKET = new PublicKey(new Uint8Array(32).fill(9));
function guard(over: Partial<LevGuardV22> = {}): LevGuardV22 {
  return {
    market: MARKET, riskKey: PublicKey.default, t0Slot: T0, assetIndex: 0, version: 1, bump: 255, flags: 0, mintAuthLive: false, freezeAuthLive: false,
    roundActive: false, roundLpLong: false, repJDumpBps: 0, repMIndBps: 0, repLCapX100: 0, repNMultBps: 0, repSlot: 0n, holderDumpBps: 0, roundKeepBps: 0,
    touchedN: 0, holderDumpSlot: 0n, pbLastPx: 0n, pbLastSlot: 0n, pbRefPx: 0n, pbRefSlot: 0n, pbFreezeUntil: 0n, pbOracleUntil: 0n, frozenLX100: 0, frozenNQ: 0n,
    navps: 0n, navLastEquity: 0n, navLastIn: 0n, navLastOut: 0n, navPeakCur: 0n, navPeakPrev: 0n, navRef: 0n, navBucketStart: 0n, navLastSlot: 0n, roundId: 0n,
    roundTargetQ: 0n, roundOpenSlot: 0n, burstVarPeakX100: 0, burstPeakSlot: 0n, touchedTags: [], ...over,
  };
}
/** A synthetic v2.2 growth market: $1, IMR 10%, MMR 5%, launch 5x / tier 10x, λ 1x, LP C_m $50k short 2,000 (N_cap 50,000 q, growth-1). */
function guarded(opts: { bit?: boolean; account?: LevGuardV22 | null; now?: bigint; oiLong?: bigint; oiShort?: bigint; capital?: bigint } = {}): GrowthMarketView {
  const raw = marketRaw({ launch: 500, tier: 1_000, ceil: 500, lambda: 10_000 });
  if (opts.bit !== false) {
    const M = marketOffsets(raw);
    raw[M.wrapperOff(0) + M.layout.wrapperSlot.growth + ASSET_GROWTH_FIELD_OFF.flags] |= 0x04;
  }
  return growthMarketView({
    raw,
    engine: {
      initialMarginBps: 1_000n, maintenanceMarginBps: 500n, effectivePriceE6: 1_000_000n, targetPriceE6: 1_000_000n,
      oiEffLongQ: opts.oiLong ?? 10_000n * USD, oiEffShortQ: opts.oiShort ?? 4_000n * USD, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n,
    },
    lp: { capital: opts.capital ?? 50_000n * USD, pnl: 0n, feeCredits: 0n },
    lpEffectiveQ: -2_000n * USD,
    bound: true,
    guard: { account: opts.account === undefined ? guard() : opts.account, mainnet: false },
    v22: { bandBps: 0, nowSlot: opts.now ?? T0 + 10n * DAY },
  })!;
}
const ticket = (g: GrowthMarketView, over: Partial<TicketLimitsInput> = {}) =>
  deriveTicketLimits({
    limits: marketLimits(), direction: "long", sizeQ: 0n, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n,
    growth: g, takerEquity: 1_000_000n * USD, ...over,
  });

describe("guard ABSENT", () => {
  it("guard bit set, account missing: every open is refused (132), so both sides are closed and the ticket says why", () => {
    const g = guarded({ account: null });
    expect([g.long.closed, g.short.closed]).toEqual([true, true]);
    const t = ticket(g, { sizeQ: 1n * USD });
    expect(t.halted.long).toBe(true);
    expect(t.issues.find((x) => x.kind === "lev-guard")?.message).toMatch(/safety guard isn't set up yet/);
  });
  it("CONTROL: guard bit clear and no account on devnet: no guard rules (the 5x launch ceiling stands)", () => {
    const g = guarded({ bit: false, account: null });
    expect(g.guard?.limits.applies).toBe(false);
    expect(g.long.closed).toBe(false);
    expect(g.long.maxLeverageX100).toBe(500);
  });
  it("a closing order is never blocked by the guard", () => {
    const g = guarded({ account: null });
    const t = ticket(g, { direction: "short", takerPosQ: 5n * USD, sizeQ: 0n });
    expect(t.issues.some((x) => x.kind === "lev-guard")).toBe(false);
  });
});

describe("guard PRESENT, each limit binding", () => {
  it("under 6 hours: no opens, and the ticket names the unlock time", () => {
    const g = guarded({ now: T0 + 18_000n }); // 2 h after launch -> 4 h left
    expect(g.long.closed && g.short.closed).toBe(true);
    const msg = ticket(g, { sizeQ: 1n * USD }).issues.find((x) => x.kind === "lev-guard")!.message;
    expect(msg).toBe("New market: opening positions unlocks in about 4 h, 6 hours after this market launched. You can still close.");
  });
  it("day 1: max leverage 2.48x (the guard), not the 5x launch ceiling", () => {
    const g = guarded({ now: T0 + DAY / 2n });
    expect(g.long.maxLeverageX100).toBe(248);
    expect(g.short.maxLeverageX100).toBe(248);
  });
  it("week 1: 3.95x", () => {
    expect(guarded({ now: T0 + 2n * DAY }).long.maxLeverageX100).toBe(395);
  });
  it("mature market: the growth ceiling binds (5x), the guard does not lower it", () => {
    expect(guarded({ now: T0 + 40n * DAY }).long.maxLeverageX100).toBe(500);
  });
  it("leverage at equity binds the Max: $100 of equity carries at most 248 q at 2.48x on day 1", () => {
    const g = guarded({ now: T0 + DAY / 2n });
    const t = ticket(g, { takerEquity: 100n * USD });
    expect(Number(t.growthCapQ) / 1e6).toBeCloseTo(248, 0);
    expect(t.growthCapQ! <= g.long.headroomQ!).toBe(true);
  });
  it("holder report n_mult binds the size: LP net may grow only to 10% of N_cap", () => {
    const now = T0 + 10n * DAY;
    const g = guarded({ now, account: guard({ repNMultBps: 1_000, repSlot: now - 100n }) });
    expect(g.guard!.limits.nEffQ).toBe(5_000n * USD);
    const t = ticket(g);
    expect(t.growthCapQ).toBe(3_000n * USD); // LP short 2,000: a long may add 3,000 more
    const over = ticket(g, { sizeQ: 3_000n * USD + 1n });
    expect(over.issues.find((x) => x.kind === "lev-guard")?.title).toBe("Size too big");
    expect(ticket(g, { sizeQ: 3_000n * USD }).issues.some((x) => x.kind === "lev-guard")).toBe(false);
  });
  it("short cap binds a young market's short side: users' shorts <= longs·MMR + 0.1·C_m", () => {
    // week 1: users' long 10,000; users' short = 4,000 − 2,000 (LP leg) = 2,000; cap = 10,000·5% + 50,000·10% = 5,500 -> room 3,500
    const g = guarded({ now: T0 + 2n * DAY });
    const t = ticket(g, { direction: "short" });
    expect(t.growthCapQ).toBe(3_500n * USD);
    const over = ticket(g, { direction: "short", sizeQ: 3_500n * USD + 1n });
    expect(over.issues.find((x) => x.kind === "lev-guard")?.title).toBe("Shorts capped");
  });
  it("a live W1 round: no fill may grow the LP (LP short -> no new longs)", () => {
    const now = T0 + 10n * DAY;
    const g = guarded({ now, account: guard({ roundActive: true, roundOpenSlot: now - 100n }) });
    expect(ticket(g).growthCapQ).toBe(0n);
    expect(ticket(g, { sizeQ: 1n }).issues.find((x) => x.kind === "lev-guard")?.title).toBe("Liquidity rebalancing");
  });
  it("the program's own growth room still binds when it is the smallest (C_m $3k: N_cap 3,000 q, guard size floor $200)", () => {
    const g = guarded({ now: T0 + 40n * DAY, capital: 3_000n * USD, oiLong: 1_000n * USD });
    const t = ticket(g);
    expect(t.growthCapQ! <= g.long.headroomQ!).toBe(true);
    expect(g.guard!.limits.applies).toBe(true);
  });
});

describe("RC23_OPEN_LIMITS off (the pre-rc23 wrapper): no guard is quoted", () => {
  it("the view carries no guard and the 5x ceiling stands", () => {
    __setRc23OpenLimitsForTest(false);
    const g = guarded({ now: T0 + DAY / 2n });
    expect(g.guard).toBeNull();
    expect(g.long.maxLeverageX100).toBe(500);
  });
});
