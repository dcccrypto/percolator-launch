/**
 * GH#1175 — Homepage insurance fund sanity cap
 *
 * Root cause: corrupt insurance_fund values (~2-3e17) passed
 * isSaneMarketValue (< 1e18) but, when multiplied by oracle price
 * (e.g. $130 SOL), produced ~$29.8B on the homepage while the earn
 * page correctly showed ~$1,115.
 *
 * Fix: mirror the earn page's hard cap of 1e13 micro-units.
 */

import { describe, it, expect } from 'vitest';

// ─── inline the same logic as app/app/page.tsx ────────────────────────────
function isSaneMarketValue(v: number | null | undefined): boolean {
  if (v == null) return false;
  return v > 0 && v < 1e18 && Number.isFinite(v);
}

const MAX_PER_MARKET_USD = 10_000_000_000;

function toUsdWithFallback(
  raw: number,
  decimals: number | null,
  price: number | null,
): number {
  if (!isSaneMarketValue(raw)) return 0;
  const d = Math.min(Math.max(decimals ?? 6, 0), 18);
  const p = price ?? 0;
  const usd = p > 0 ? (raw / 10 ** d) * p : raw / 10 ** d;
  return usd > MAX_PER_MARKET_USD ? 0 : usd;
}

/** Homepage insurance reducer (fixed version) */
function calcInsurance(
  markets: Array<{
    insurance_fund: number | null;
    insurance_balance: number | null;
    decimals: number | null;
    last_price: number | null;
  }>,
): number {
  return markets.reduce((s, m) => {
    const raw = Number(m.insurance_fund ?? m.insurance_balance ?? 0);
    if (!isSaneMarketValue(raw)) return s;
    // GH#1175 fix: same 1e13 sanity cap as useEarnStats
    if (raw > 1e13) return s;
    return s + toUsdWithFallback(raw, m.decimals, m.last_price);
  }, 0);
}

/** Homepage insurance reducer (buggy version — no sanity cap) */
function calcInsuranceBuggy(
  markets: Array<{
    insurance_fund: number | null;
    insurance_balance: number | null;
    decimals: number | null;
    last_price: number | null;
  }>,
): number {
  return markets.reduce((s, m) => {
    const raw = Number(m.insurance_fund ?? m.insurance_balance ?? 0);
    if (!isSaneMarketValue(raw)) return s;
    return s + toUsdWithFallback(raw, m.decimals, m.last_price);
  }, 0);
}
// ──────────────────────────────────────────────────────────────────────────

describe('Homepage insurance fund sanity cap (GH#1175)', () => {
  const SOL_PRICE = 130; // $130/SOL at time of bug report

  const goodMarket = {
    // ~$1,115 worth of USDC (6 decimals, no price oracle needed)
    insurance_fund: 1_115_000_000, // 1115 USDC in micro-units
    insurance_balance: null,
    decimals: 6,
    last_price: 1,
  };

  const corruptMarket = {
    // 5e15 raw USDC micro-units — passes isSaneMarketValue (< 1e18) but is
    // corrupt slab data from bad tier detection. last_price=null triggers the
    // "stablecoin fallback" path (raw / 10^decimals), yielding $5B per market.
    // The earn page caps at 1e13, so this market contributes $0 there.
    insurance_fund: 5e15,
    insurance_balance: null,
    decimals: 6, // USDC market — no price oracle, uses fallback path
    last_price: null,
  };

  it('correct market: fixed calc matches buggy calc (no difference for sane data)', () => {
    const fixed = calcInsurance([goodMarket]);
    const buggy = calcInsuranceBuggy([goodMarket]);
    expect(fixed).toBeCloseTo(1115, 0);
    expect(buggy).toBeCloseTo(1115, 0);
  });

  it('corrupt market: buggy calc produces ~$5B (single market, under per-market cap)', () => {
    const buggy = calcInsuranceBuggy([corruptMarket]);
    // 5e15 / 1e6 = $5B — passes isSaneMarketValue and per-market $10B cap
    expect(buggy).toBeCloseTo(5_000_000_000, -6);
  });

  it('corrupt market: fixed calc clamps corrupt value to $0', () => {
    const fixed = calcInsurance([corruptMarket]);
    expect(fixed).toBe(0);
  });

  it('mixed markets: fixed calc returns only the sane contribution (many corrupt markets still = $1,115)', () => {
    const manyCorrupt = Array(6).fill(corruptMarket);
    const fixed = calcInsurance([goodMarket, ...manyCorrupt]);
    // All corrupt markets contribute $0; only the good one counts
    expect(fixed).toBeCloseTo(1115, 0);
    expect(fixed).toBeLessThan(10_000);
  });

  it('mixed markets: buggy calc is massively inflated (multiple corrupt markets sum > $10B)', () => {
    // 6 corrupt markets × ~$5B each ≈ $30B total (simulates the $29.8B bug)
    const manyCorrupt = Array(6).fill(corruptMarket);
    const buggy = calcInsuranceBuggy([goodMarket, ...manyCorrupt]);
    expect(buggy).toBeGreaterThan(25_000_000_000);
  });

  it('boundary: value at exactly 1e13 is allowed', () => {
    const atBoundary = { ...goodMarket, insurance_fund: 1e13, decimals: 9, last_price: null };
    const fixed = calcInsurance([atBoundary]);
    // 1e13 / 1e9 = $10,000 — valid
    expect(fixed).toBeCloseTo(10_000, 0);
  });

  it('boundary: value just above 1e13 is clamped', () => {
    const justOver = { ...goodMarket, insurance_fund: 1e13 + 1, decimals: 9, last_price: null };
    const fixed = calcInsurance([justOver]);
    expect(fixed).toBe(0);
  });

  it('null insurance_fund uses insurance_balance fallback', () => {
    const balanceMarket = {
      insurance_fund: null,
      insurance_balance: 500_000_000, // 500 USDC
      decimals: 6,
      last_price: 1,
    };
    const fixed = calcInsurance([balanceMarket]);
    expect(fixed).toBeCloseTo(500, 0);
  });

  it('sentinel u64::MAX value is filtered by isSaneMarketValue', () => {
    const sentinel = {
      insurance_fund: 1.844e19, // u64::MAX
      insurance_balance: null,
      decimals: 9,
      last_price: SOL_PRICE,
    };
    const fixed = calcInsurance([sentinel]);
    expect(fixed).toBe(0);
  });
});
