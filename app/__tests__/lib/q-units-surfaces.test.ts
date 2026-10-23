/**
 * Engine size / OI / volume ("Q") are base-asset amounts at POS_SCALE 1e6
 * whatever the mint's decimals (see lib/q-usd.ts). These surfaces converted
 * them with a decimals-based divisor (or formatted raw Q as currency), so a
 * 9-decimal market (SOL) read 1000x low, and raw volume_24h rendered as dollars.
 *
 * Live devnet numbers (2026-09-29): SOL 3_396_789 Q @ $117.029874 -> $397.53
 * (the API's volume_24h_usd); COLLECT 85_420_329_419 Q @ $0.019395 -> $1,656.73.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { qToUsd, rowVolumeUsd, Q_DECIMALS } from "@/lib/q-usd";

const root = path.join(__dirname, "..", "..");
const src = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("rowVolumeUsd", () => {
  it("SOL: Q x price, not Q / 10^9 x price ($0.40)", () => {
    const usd = rowVolumeUsd({ volume_24h: 3_396_789, last_price: 117.029874 });
    expect(usd).toBeCloseTo(397.53, 2);
    expect(usd).not.toBeCloseTo(0.4, 1);
  });
  it("COLLECT", () => {
    expect(rowVolumeUsd({ volume_24h: 85_420_329_419, last_price: 0.019395 })).toBeCloseTo(1656.73, 1);
  });
  it("prefers the API's volume_24h_usd", () => {
    expect(rowVolumeUsd({ volume_24h: 3_396_789, volume_24h_usd: 397.53, last_price: 1 })).toBe(397.53);
  });
  it("null volume -> null (unknown), 0 -> 0, no price -> null", () => {
    expect(rowVolumeUsd({ volume_24h: null, last_price: 1 })).toBeNull();
    expect(rowVolumeUsd({ volume_24h: 0, last_price: 1 })).toBe(0);
    expect(rowVolumeUsd({ volume_24h: 5, last_price: null })).toBeNull();
    expect(rowVolumeUsd(undefined)).toBeNull();
  });
  it("Q_DECIMALS is log10(Q_SCALE)", () => {
    expect(Q_DECIMALS).toBe(6);
    expect(qToUsd(1_000_000, 2)).toBe(2);
  });
});

/** Static guards: each surface must not reintroduce a decimals-based Q conversion. */
describe("Q-unit conversions are not decimals-based", () => {
  it("markets list page: OI/volume/sort use qToUsd, no tokenDivisor", () => {
    const s = src("app/markets/page.tsx");
    expect(s).not.toMatch(/tokenDivisor/);
    expect(s).not.toMatch(/Number\(getOI\(m\)\) \/ 10 \*\* mintDecimals/);
    expect(s).toMatch(/qToUsd\(Number\(oiTokensRaw\)/);
    expect(s).toMatch(/qToUsd\(Number\(volume24hRaw\)/);
  });
  it("MarketInfoBar: OI goes through qToUsd (Q_SCALE); volume goes through rowVolumeUsd", () => {
    const s = src("components/trade/MarketInfoBar.tsx");
    expect(s).not.toMatch(/Math\.pow\(10, decimals\)/);
    // #38: both OI sources are Q quantities, converted by the shared helper (which divides by Q_SCALE).
    expect(s).toMatch(/qToUsd\(totalOI != null \? Number\(totalOI\) : rawOiAtoms, priceUsd\)/);
    expect(s).toMatch(/rowVolumeUsd\(/);
    expect(s).not.toMatch(/const volume = market\?\.volume_24h/);
  });
  it("LiveMarketRail: volume column is USD, not raw volume_24h", () => {
    const s = src("components/landing/LiveMarketRail.tsx");
    expect(s).not.toMatch(/volume24h=\{(stats\?|m)\.volume_24h/);
    expect(s).toMatch(/volume24h=\{rowVolumeUsd\(m\)/);
  });
  it("MarketStatsCard OI, PositionPanel size, SystemCapitalCard OI, my-markets OI, CreatorMarketRow OI use Q_SCALE", () => {
    expect(src("components/trade/MarketStatsCard.tsx")).toMatch(/Number\(atoms\) \/ Q_SCALE\) \* priceUsd/);
    const pp = src("components/trade/PositionPanel.tsx");
    expect(pp).toMatch(/Number\(absPosition\) \/ Q_SCALE/);
    expect(pp).not.toMatch(/Number\(absPosition\) \/ \(?10 \*\* decimals/);
    expect(src("components/trade/SystemCapitalCard.tsx")).toMatch(/engine \? divisor : Q_SCALE/);
    expect(src("app/my-markets/page.tsx")).toMatch(/totalShortOiQ\) \/ Q_SCALE/);
    expect(src("components/my-markets/CreatorMarketRow.tsx")).toMatch(/isV17 \? Q_SCALE/);
  });
  it("/api/stats fallback paths use qToUsd / Q_SCALE, not row decimals", () => {
    const s = src("app/api/stats/route.ts");
    expect(s).not.toMatch(/raw \/ 10 \*\* d\b/);
    expect(s).not.toMatch(/rawOi \/ 10 \*\* d\b/);
    expect(s).toMatch(/qToUsd\(raw, p\)/);
  });
});

describe("/markets volume sort is USD-normalised", () => {
  // Raw volume_24h is base-token Q: COLLECT's 85.4B Q (~$1,657) would outrank SOL's
  // 3.4M Q (~$398) by 25,000x on raw Q, and a sub-cent memecoin always tops the list.
  it("sorts on rowVolumeUsd (with the sentinel guard), falling back to USD OI", () => {
    const page = src("app/markets/page.tsx");
    const sortBlock = page.slice(page.indexOf("const volumeUsdSortKey"), page.indexOf('case "oi"'));
    expect(sortBlock).toMatch(/isSupabaseSentinel\(m\.supabase\?\.volume_24h\)/);
    expect(sortBlock).toMatch(/rowVolumeUsd\(m\.supabase/);
    expect(sortBlock).toMatch(/volumeUsdSortKey\(a\) \|\| getOIUsdSortKey\(a\)/);
    expect(page).not.toMatch(/const volumeSortKey = \(m: MergedMarket\): bigint/);
  });
  it("the USD ordering differs from the raw-Q ordering on live numbers", () => {
    const sol = { volume_24h: 3_396_789, last_price: 117.029874 };
    const collect = { volume_24h: 85_420_329_419, last_price: 0.019395 };
    expect(collect.volume_24h).toBeGreaterThan(sol.volume_24h); // raw Q: COLLECT first
    expect(rowVolumeUsd(collect)!).toBeGreaterThan(rowVolumeUsd(sol)!); // USD: also COLLECT ($1,657 > $398)
    const pengu = { volume_24h: 50_000_000_000, last_price: 0.0000001 }; // $5 of volume
    expect(pengu.volume_24h).toBeGreaterThan(sol.volume_24h); // raw Q would put it above SOL
    expect(rowVolumeUsd(pengu)!).toBeLessThan(rowVolumeUsd(sol)!); // USD correctly ranks it below
  });
});
