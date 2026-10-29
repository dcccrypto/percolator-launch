/**
 * App bug 2026-10-29 (product review findings 4 / 5): behaviour-only checks written against APIs that existed before the fix
 * (growthFor, growthMarketView, deriveTicketLimits), so they fail on the old ticket and pass on the new one (the negative control).
 * Default build switch (rc23 open limits on).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioLegs, decodePortfolioRisk } from "@/lib/limits/decode";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { growthFor } from "@/hooks/useMarketLimits";
import { growthMarketView } from "@/lib/v21/growth-market";
import { deriveTicketLimits } from "@/lib/limits/ticket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { marketOffsets } from "@/lib/v22/market-offsets";
import { marketRaw } from "../v21/fixtures";
import { marketLimits, OWNER_A } from "../limits/fixtures";

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const USD = 1_000_000n;
const T0 = 1_000_000n;
const DAY = 216_000n;

describe("κ cap: real CHILLHOUSE-T bytes", () => {
  it("the ticket's room is at most 253 bps of the usable depth (the old ticket promised 0.5 of it: 10,250 q)", () => {
    const DIR = path.join(__dirname, "../../fixtures/v22-growth");
    const load = (n: string): Uint8Array => new Uint8Array(Buffer.from((JSON.parse(readFileSync(path.join(DIR, n), "utf8")) as { data: string }).data, "base64"));
    const raw = load("chillhouse-t.market.json");
    const lpBytes = load("chillhouse-t.lp.json");
    const engine = decodeMarketEngineView(raw, 0)!;
    const vaultLp = decodeAssetVaultLp(raw, 0);
    const lp = { ...decodePortfolioRisk(lpBytes)!, address: new PublicKey(vaultLp!.vaultLpPortfolio), posQ: 0n, legs: decodePortfolioLegs(lpBytes) };
    const v = growthFor({ engine, vaultLp }, { lp }, lpEffectiveSignedQ(lpBytes, engine, 0, engine.marketId), raw, 0, 512_136_545n)!;
    const kappaRoom = ((v.long.capDepthE6! * 253n) / 10_000n) * 1_000_000n / engine.effectivePriceE6;
    expect(v.long.headroomQ! <= kappaRoom).toBe(true);
    expect(v.long.headroomQ! < 10_250n).toBe(true);
  });
});

describe("leverage guard present (growth guard bit set)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guardAccount: any = {
    market: new PublicKey(new Uint8Array(32).fill(9)), t0Slot: T0, assetIndex: 0, flags: 0, mintAuthLive: false, freezeAuthLive: false, roundActive: false,
    roundOpenSlot: 0n, repJDumpBps: 0, repMIndBps: 0, repLCapX100: 0, repNMultBps: 0, repSlot: 0n, holderDumpBps: 0, holderDumpSlot: 0n, pbLastPx: 0n,
    pbLastSlot: 0n, pbRefPx: 0n, pbRefSlot: 0n, pbFreezeUntil: 0n, pbOracleUntil: 0n, frozenLX100: 0, frozenNQ: 0n, burstVarPeakX100: 0, burstPeakSlot: 0n,
  };
  const view = (now: bigint, account: unknown = guardAccount) => {
    const raw = marketRaw({ launch: 500, tier: 1_000, ceil: 500, lambda: 10_000 });
    const M = marketOffsets(raw);
    raw[M.wrapperOff(0) + M.layout.wrapperSlot.growth + 39] |= 0x04; // growth flags bit 2: the market has a guard
    return growthMarketView({
      raw,
      engine: { initialMarginBps: 1_000n, maintenanceMarginBps: 500n, effectivePriceE6: 1_000_000n, oiEffLongQ: 10_000n * USD, oiEffShortQ: 4_000n * USD, tradeFeeBaseBps: 30n, maxTradingFeeBps: 630n },
      lp: { capital: 50_000n * USD, pnl: 0n, feeCredits: 0n },
      lpEffectiveQ: -2_000n * USD,
      bound: true,
      v22: { bandBps: 0, nowSlot: now },
      guard: { account, mainnet: false },
    } as Parameters<typeof growthMarketView>[0])!;
  };
  const ticket = (v: ReturnType<typeof view>, direction: "long" | "short", sizeQ = 0n) =>
    deriveTicketLimits({ limits: marketLimits(), direction, sizeQ, takerPosQ: 0n, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n, growth: v, takerEquity: 1_000_000n * USD });

  it("first 6 hours: the ticket does not offer an open (the program refuses every one)", () => {
    const v = view(T0 + 9_000n);
    expect(v.long.closed && v.short.closed).toBe(true);
    expect(ticket(v, "long", 1n * USD).halted.long).toBe(true);
  });
  it("guard required but missing: no open offered", () => {
    expect(view(T0 + 10n * DAY, null).long.closed).toBe(true);
  });
  it("day 1: max leverage is the guard's ~2.48x, not the 5x ceiling", () => {
    expect(view(T0 + DAY / 2n).long.maxLeverageX100).toBeLessThan(500);
  });
  it("week 1, short side: the Max respects the short cap (users' shorts <= longs·5% + 10%·C_m = 5,500; 2,000 in already)", () => {
    const t = ticket(view(T0 + 2n * DAY), "short");
    expect(t.growthCapQ! <= 3_500n * USD).toBe(true);
  });
});
