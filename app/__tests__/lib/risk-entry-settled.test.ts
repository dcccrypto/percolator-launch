/**
 * #3534: on the device a position was opened from, a loss settlement had already moved out of `capital` was counted
 * again by `capital + q x (mark - cachedEntry)`: liquidation price, cushion / tier and margin health read worse than
 * the account is. A fully settled single leg now prices its RISK from the settled back-solve (lib/risk-entry.ts);
 * the display entry is unchanged.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import {
  parseAssetSettleState,
  riskEntryFromSettled,
  riskLegFields,
  settledRiskAnchorE6,
  type AssetSettleState,
  type RiskLegSnap,
} from "@/lib/risk-entry";
import { ADL_ONE, parseAssetAdlFactors, type AssetAdlFactors } from "@/lib/v17-adl";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { computePositionPnl, portfolioPositionPnl, type PositionPnlInput } from "@/lib/position-pnl";
import { computeMarginCushion } from "@/lib/liquidation-risk";

const E6 = 1_000_000n;
const fixture = (f: string) => {
  const j = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", f), "utf8"));
  return new Uint8Array(Buffer.from(j.dataBase64 ?? j.data, "base64"));
};

afterEach(() => __setDevnetV22ForTest(null));

describe("parseAssetSettleState: offsets cross-checked on captured markets", () => {
  it.each([
    ["v22-market-single-asset-SOL.json", true],
    ["Azagguvr.sol.market.json", false],
    ["trump-v18-slab.json", false],
  ] as const)("%s (v2.2 flag %s)", (f, v22) => {
    __setDevnetV22ForTest(v22);
    const d = fixture(f);
    const s = parseAssetSettleState(d, 0)!;
    const a = parseAssetAdlFactors(d, 0)!;
    expect(s).not.toBeNull();
    // effective_price and the side epochs agree with the decoders already pinned on live slabs.
    expect(s.effectivePriceE6).toBe(decodeMarketEngineView(d)!.effectivePriceE6);
    expect(s.epochLong).toBe(a.epochLong);
    expect(s.epochShort).toBe(a.epochShort);
    // On a balanced book (a_long == a_short == ADL_ONE) K and F accrue equal and opposite, in whole ADL_ONE steps
    // (k_delta = price_delta x a_side): a misplaced offset would not produce this.
    expect(a.aLong).toBe(ADL_ONE);
    expect(a.aShort).toBe(ADL_ONE);
    expect(s.kLong).not.toBe(0n);
    expect(s.kLong).toBe(-s.kShort);
    expect(s.fLong).toBe(-s.fShort);
    expect(s.kLong % ADL_ONE).toBe(0n);
    expect(s.kfEpochLong).toBeGreaterThan(0n);
    // v2.2 carries the holding-rent indices; v2.1 has none.
    expect(s.rentIndexLong !== undefined).toBe(v22);
    // ...and parseAssetAdlFactors hands them on.
    expect(a.settle).toEqual(s);
  });
  it("a too-short or non-wrapper buffer is null (today's entry)", () => {
    expect(parseAssetSettleState(new Uint8Array(64), 0)).toBeNull();
  });
});

// The issue's worked example: one long unit, entry $100, $20 capital, 5% maintenance. The price falls to $90 and a
// crank settles it: capital $10, pnl 0, K re-snapped. True equity $10, liquidation ~$84.21; the cached-entry math
// read ~$94.74 (above the mark, i.e. "past liquidation").
const UNIT = 1_000_000n; // 1 token at 6 decimals (Q)
const SETTLE: AssetSettleState = {
  effectivePriceE6: 90n * E6,
  kLong: -10n * ADL_ONE,
  kShort: 10n * ADL_ONE,
  fLong: 0n,
  fShort: 0n,
  kfEpochLong: 7n,
  kfEpochShort: 7n,
  bLong: 0n,
  bShort: 0n,
  epochLong: 0n,
  epochShort: 0n,
};
const FACTORS: AssetAdlFactors = { aLong: ADL_ONE, aShort: ADL_ONE, epochLong: 0n, epochShort: 0n, modeLong: 0, modeShort: 0, settle: SETTLE };
const LONG_LEG: RiskLegSnap = { side: 0, kSnap: SETTLE.kLong, fSnap: 0n, kfEpochSnap: 7n, epochSnap: 0n, bSnap: 0n, bEpochSnap: 0n, stale: false, bStale: false };

const input = (o: Partial<PositionPnlInput> = {}): PositionPnlInput => ({
  basisQ: UNIT,
  aBasis: ADL_ONE,
  epochSnap: 0n,
  adlFactors: FACTORS,
  markE6: 90n * E6,
  anchorMarkE6: 90n * E6,
  cachedEntryE6: 100n * E6, // the opening device's fill price
  onChainPnl: 0n,
  initialMarginBps: 1000n,
  maintenanceMarginBps: 500n,
  capital: 10n * E6,
  riskLeg: LONG_LEG,
  activeLegCount: 1,
  ...o,
});
const near = (v: bigint | null, dollars: number) => {
  expect(v).not.toBeNull();
  expect(Math.abs(Number(v!) / 1e6 - dollars)).toBeLessThan(0.01);
};

describe("computePositionPnl: the risk entry of a fully settled leg (#3534)", () => {
  it("worked example: liq ~$84.21 from the settled back-solve, not ~$94.74; the display entry stays the fill price", () => {
    const r = computePositionPnl(input());
    expect(r.riskEntrySettled).toBe(true);
    expect(r.riskEntry).toBe(90n * E6); // pnl 0: everything is in capital, anchored at effective_price
    near(r.liquidationPriceE6, 84.2105);
    expect(r.entry).toBe(100n * E6);
    expect(r.entrySource).toBe("cache");
    expect(r.unrealizedPnl).toBe(-10n * E6); // "PnL since entry" is unchanged: an honest since-entry figure
    // The cushion at the mark is positive (safe-ish), where the double count put it below zero.
    const cushion = (entry: bigint) =>
      computeMarginCushion({ positionSize: UNIT, entryPriceE6: entry, capital: 10n * E6, markPriceE6: 90n * E6, maintenanceMarginBps: 500n, initialMarginBps: 1000n });
    expect(cushion(r.riskEntry)!).toBeGreaterThan(0);
    expect(cushion(r.entry)!).toBeLessThan(0);
  });

  it("a part-settled leg with pnl left over is anchored too: equity = capital + pnl + q x (mark - effective)", () => {
    // pnl -3 still in pnl (not yet moved out of capital), capital 13: same $10 equity, same liquidation price.
    const r = computePositionPnl(input({ onChainPnl: -3n * E6, capital: 13n * E6 }));
    expect(r.riskEntry).toBe(93n * E6);
    near(r.liquidationPriceE6, 84.2105);
  });

  it("a short: entry = effective + pnl/|q|", () => {
    const shortLeg = { ...LONG_LEG, side: 1, kSnap: SETTLE.kShort };
    const r = computePositionPnl(input({ basisQ: -UNIT, riskLeg: shortLeg, onChainPnl: -2n * E6, capital: 10n * E6, markE6: 90n * E6 }));
    expect(r.riskEntry).toBe(88n * E6);
    expect(r.riskEntrySettled).toBe(true);
  });

  it.each([
    ["K pending (k_snap behind K_side)", { riskLeg: { ...LONG_LEG, kSnap: SETTLE.kLong + ADL_ONE } }],
    ["F pending", { riskLeg: { ...LONG_LEG, fSnap: 1n } }],
    ["social loss (B) pending", { riskLeg: { ...LONG_LEG, bSnap: 1n } }],
    ["kf epoch behind", { riskLeg: { ...LONG_LEG, kfEpochSnap: 6n } }],
    ["stale leg", { riskLeg: { ...LONG_LEG, stale: true } }],
    ["side epoch moved (reset)", { riskLeg: { ...LONG_LEG, epochSnap: 1n } }],
    ["multi-leg portfolio (pnl is per portfolio)", { activeLegCount: 2 }],
    ["no leg snapshot (legacy account)", { riskLeg: null, activeLegCount: null }],
    ["no settle indices (unreadable)", { adlFactors: { ...FACTORS, settle: null } }],
    ["leg side does not match the position", { riskLeg: { ...LONG_LEG, side: 1 } }],
  ] as const)("%s: today's entry, and today's ~$94.74", (_name, o) => {
    const r = computePositionPnl(input(o as Partial<PositionPnlInput>));
    expect(r.riskEntrySettled).toBe(false);
    expect(r.riskEntry).toBe(100n * E6);
    near(r.liquidationPriceE6, 94.7368);
  });

  it("v2.2 rent: a rent snapshot behind the index is pending; one matching it is settled", () => {
    const v22 = { ...FACTORS, settle: { ...SETTLE, rentIndexLong: 50n, rentIndexShort: 0n } };
    expect(computePositionPnl(input({ adlFactors: v22, riskLeg: { ...LONG_LEG, rentSnap: 49n } })).riskEntrySettled).toBe(false);
    expect(computePositionPnl(input({ adlFactors: v22, riskLeg: LONG_LEG })).riskEntrySettled).toBe(false); // index but no snap
    expect(computePositionPnl(input({ adlFactors: v22, riskLeg: { ...LONG_LEG, rentSnap: 50n } })).riskEntrySettled).toBe(true);
  });

  it("portfolioPositionPnl (live-mark surfaces) takes the leg off the polled account", () => {
    const r = portfolioPositionPnl(
      {
        account: { positionSize: UNIT, adlABasis: ADL_ONE, adlEpochSnap: 0n, pnl: 0n, capital: 10n * E6, riskLeg: LONG_LEG, activeLegCount: 1 },
        adlFactors: FACTORS,
        effectiveEntryPrice: 100n * E6,
        entryPriceSource: "cache",
        initialMarginBps: 1000n,
        maintenanceMarginBps: 500n,
        oraclePriceE6: 90n * E6,
      },
      90n * E6,
    );
    expect(r.riskEntry).toBe(90n * E6);
    near(r.liquidationPriceE6, 84.2105);
  });
});

describe("helpers", () => {
  it("riskEntryFromSettled rounds toward the riskier entry", () => {
    // long, pnl -1 atom over 3 Q: exact entry = 90 + 1e6/3 = 90.333..; rounded UP for a long.
    expect(riskEntryFromSettled(3n, -1n, 90n * E6)).toBe(90n * E6 + 333_334n);
    // short, pnl -1 atom over 3 Q: exact entry = 90 - 0.333..; rounded DOWN for a short.
    expect(riskEntryFromSettled(-3n, -1n, 90n * E6)).toBe(90n * E6 - 333_334n);
    expect(riskEntryFromSettled(UNIT, 100n * E6, 90n * E6)).toBeNull(); // not a positive price
  });
  it("riskLegFields: the first active leg and the active count", () => {
    const leg = (active: boolean, side: number) => ({ ...LONG_LEG, active, side });
    expect(riskLegFields([leg(false, 1), leg(true, 0)])).toEqual({ riskLeg: { ...LONG_LEG, side: 0 }, activeLegCount: 1 });
    expect(riskLegFields([leg(true, 0), leg(true, 1)]).activeLegCount).toBe(2);
    expect(riskLegFields([])).toEqual({ riskLeg: null, activeLegCount: 0 });
  });
  it("settledRiskAnchorE6 needs exactly one active leg", () => {
    expect(settledRiskAnchorE6(SETTLE, LONG_LEG, 1)).toBe(90n * E6);
    expect(settledRiskAnchorE6(SETTLE, LONG_LEG, 0)).toBeNull();
    expect(settledRiskAnchorE6(SETTLE, LONG_LEG, 2)).toBeNull();
  });
});

describe("wiring: the risk surfaces read the risk entry, display keeps the entry (#3534)", () => {
  const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  it.each(["components/trade/PositionsDock.tsx", "components/trade/PositionPanel.tsx"])("%s: liq display + cushion", (f) => {
    const s = src(f);
    expect(s).toContain("const riskEntryE6 = pnlResult.riskEntry;");
    expect(s.match(/entryPriceE6: riskEntryE6,/g)?.length).toBe(2);
  });
  it.each([
    "components/portfolio/PortfolioPositionsView.tsx",
    "components/portfolio/LiquidationRiskItem.tsx",
    "components/trade/OtherMarketPositions.tsx",
    "hooks/usePortfolio.ts",
    "app/trader/[wallet]/page.tsx",
  ])("%s: risk entry from the polled position", (f) => {
    expect(src(f)).toContain("entryPriceE6: pos.riskEntryPrice ?? pos.effectiveEntryPrice,");
  });
  it("the ticket's before/after preview and the account mappers", () => {
    const t = src("components/trade/OrderTicket.tsx");
    expect(t).toContain("computeLiqPrice(existingRiskEntryE6, capital,");
    expect(t).toContain("entryPriceE6: existingRiskEntryE6,");
    expect(src("lib/userAccountScan.ts")).toContain("...riskLegFields(portfolio.legs),");
    expect(src("hooks/usePortfolio.ts")).toContain("riskEntryPrice: pnlResult.riskEntry,");
  });
});
