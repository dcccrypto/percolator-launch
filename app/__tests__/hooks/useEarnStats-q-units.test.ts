/**
 * Earn vault cards: 24h volume and OI came from raw engine-Q quantities divided
 * by the COLLATERAL decimals with no price, so they read as dollars ("USD" =
 * base-asset amount). COLLECT (~$0.019) showed ~51x its real volume, which the
 * page multiplies by the fee bps for its fee-revenue estimate. And max leverage
 * used a bare floor(10000 / bps), showing a 3x launch (3334 bps) as 2x.
 *
 * Numbers are the live devnet /api/markets rows (2026-09-29).
 */
import { describe, it, expect } from "vitest";
import { buildMarketVaultInfo, computeMaxLeverageFromBps } from "@/hooks/useEarnStats";

const noVaults = {};
function build(row: Record<string, unknown>, lev: Record<string, number> = {}) {
  return buildMarketVaultInfo("S", "SYM", "Sym", null, noVaults, new Map([["S", row]]), lev);
}

describe("buildMarketVaultInfo volume / OI units", () => {
  const collect = { volume_24h: 85_420_329_419, volume_24h_usd: 1656.73, last_price: 0.019395, total_open_interest: 55_705_224_804, total_open_interest_usd: 1080.4 };

  it("COLLECT: volume is the API's USD (1656.73), not 85,420 'USD'", () => {
    expect(build(collect).volume24h).toBeCloseTo(1656.73, 2);
  });

  it("falls back to Q x price when volume_24h_usd is absent (still ~$1,656)", () => {
    const { volume_24h_usd: _u, ...noUsd } = collect;
    expect(build(noUsd).volume24h).toBeCloseTo(1656.73, 1);
  });

  it("SOL row (3_396_789 Q @ $117.029874) is ~$397.53", () => {
    const sol = { volume_24h: 3_396_789, last_price: 117.029874 };
    expect(build(sol).volume24h).toBeCloseTo(397.53, 2);
  });

  it("OI fallback (no total_open_interest_usd) is Q x price", () => {
    const { total_open_interest_usd: _o, ...noOiUsd } = collect;
    expect(build(noOiUsd).totalOI).toBeCloseTo(1080.4, 0);
  });

  it("no volume -> 0, not NaN", () => {
    expect(build({ last_price: 1 }).volume24h).toBe(0);
  });
});

describe("computeMaxLeverageFromBps", () => {
  it.each([
    [1538n, 6.5], // live COLLECT: floor(10000/1538) was 6
    [1000n, 10],
    [666n, 15], // live SOL
    [3334n, 3], // a 3x launch stores ceil(10000/3)=3334; bare floor gave 2
    [2222n, 4.5],
  ])("%s bps -> %sx", (bps, x) => {
    expect(computeMaxLeverageFromBps(bps)).toBe(x);
  });
  it("unknown -> 10 fallback", () => {
    expect(computeMaxLeverageFromBps(null)).toBe(10);
  });
});

// Council GO1106-UX #2: "The vault table says FEE 0.10% for every market, while the selected-vault rail says FEE 0.30%."
// The table read the DB row's trading_fee_bps (default 10); the charged on-chain fee (30 bps on every v2.2 market) wins.
describe("buildMarketVaultInfo fee source", () => {
  it("the charged on-chain fee wins over the DB row and the default", () => {
    expect(buildMarketVaultInfo("S", "SYM", "Sym", null, noVaults, new Map([["S", {}]]), {}, { S: 30 }).tradingFeeBps).toBe(30);
    expect(buildMarketVaultInfo("S", "SYM", "Sym", null, noVaults, new Map([["S", { trading_fee_bps: 10 }]]), {}, { S: 30 }).tradingFeeBps).toBe(30);
  });
  it("CONTROL: no on-chain fee -> the DB row, then the 10 bps default", () => {
    expect(build({ trading_fee_bps: 25 }).tradingFeeBps).toBe(25);
    expect(build({}).tradingFeeBps).toBe(10);
  });
});
