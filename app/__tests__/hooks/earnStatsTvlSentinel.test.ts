/**
 * GH#1165 — /earn TVL sentinel filter for lp_collateral
 *
 * Root cause: corrupt lp_collateral values (e.g. ~4e14 at 6 decimals = $400M)
 * passed the existing sentinel filter (isSentinel = v > 1e18) but produced
 * wildly inflated TVL on the /earn page.
 *
 * Fix: add a USD-value cap after dividing by 10^decimals. Any vault claiming
 * > $10M USD is corrupt and should be treated as 0 (MAX_VAULT_USD = 10_000_000).
 */

import { describe, it, expect } from 'vitest';

// ─── Inline the same logic as hooks/useEarnStats.ts ───────────────────────
const isSentinel = (v: number) => v > 1e18;
const MAX_VAULT_USD = 10_000_000; // $10M cap per vault

function computeVaultBalance(lp_collateral: number | null, collDivisor: number): number {
  const vaultBalanceRaw = lp_collateral ?? 0;
  const vaultBalanceHuman = isSentinel(vaultBalanceRaw) ? Infinity : vaultBalanceRaw / collDivisor;
  return vaultBalanceHuman > MAX_VAULT_USD ? 0 : vaultBalanceRaw;
}

function computeTvl(markets: { lp_collateral: number | null; decimals: number }[]): number {
  return markets.reduce((s, m) => {
    const collDivisor = 10 ** m.decimals;
    const vaultBalance = computeVaultBalance(m.lp_collateral, collDivisor);
    return s + vaultBalance / collDivisor;
  }, 0);
}
// ──────────────────────────────────────────────────────────────────────────

describe('useEarnStats — lp_collateral sentinel filter (GH#1165)', () => {
  it('passes legitimate USDC LP (e.g. 1,000 USDC at 6 decimals)', () => {
    const raw = 1_000 * 1e6; // 1,000 USDC
    const bal = computeVaultBalance(raw, 1e6);
    expect(bal).toBe(raw);
  });

  it('passes legitimate SOL LP (e.g. 500 SOL at 9 decimals)', () => {
    const raw = 500 * 1e9; // 500 SOL
    const bal = computeVaultBalance(raw, 1e9);
    expect(bal).toBe(raw);
    expect(bal / 1e9).toBe(500); // 500 SOL in human units
  });

  it('blocks corrupt USDC value producing $400M TVL (4e14 at 6 decimals)', () => {
    // 4e14 / 1e6 = 4e8 = $400M — should be zeroed
    const corrupt = 4e14;
    const bal = computeVaultBalance(corrupt, 1e6);
    expect(bal).toBe(0);
  });

  it('blocks corrupt SOL value producing $400M TVL (4e17 at 9 decimals)', () => {
    // 4e17 / 1e9 = 4e8 = $400M SOL (at any price this is huge) — should be zeroed
    const corrupt = 4e17;
    const bal = computeVaultBalance(corrupt, 1e9);
    expect(bal).toBe(0);
  });

  it('blocks sentinel values > 1e18', () => {
    const sentinel = 1.844e19; // u64::MAX approx
    const bal = computeVaultBalance(sentinel, 1e6);
    expect(bal).toBe(0);
  });

  it('handles null lp_collateral as 0', () => {
    const bal = computeVaultBalance(null, 1e6);
    expect(bal).toBe(0);
  });

  it('TVL with one corrupt market is not inflated', () => {
    const markets = [
      { lp_collateral: 1_000 * 1e6, decimals: 6 },   // 1,000 USDC — legit
      { lp_collateral: 4e14, decimals: 6 },            // $400M USDC — corrupt
      { lp_collateral: 500 * 1e9, decimals: 9 },      // 500 SOL — legit
    ];
    const tvl = computeTvl(markets);
    // Should only include the two legit vaults: 1,000 + 500 = 1,500 human units
    expect(tvl).toBe(1_500);
  });

  it('TVL with all legit markets aggregates correctly', () => {
    const markets = [
      { lp_collateral: 100 * 1e6, decimals: 6 },   // 100 USDC
      { lp_collateral: 200 * 1e6, decimals: 6 },   // 200 USDC
      { lp_collateral: 50 * 1e9,  decimals: 9 },   // 50 SOL
    ];
    const tvl = computeTvl(markets);
    expect(tvl).toBeCloseTo(350, 5); // 100 + 200 + 50
  });

  it('$9.9M vault is allowed (just under cap)', () => {
    // $9,900,000 in USDC micro-units
    const raw = 9_900_000 * 1e6; // 9.9e12
    const bal = computeVaultBalance(raw, 1e6);
    expect(bal).toBe(raw);
  });

  it('$10.1M vault is blocked (just over cap)', () => {
    // $10,100,000 in USDC micro-units
    const raw = 10_100_000 * 1e6; // 1.01e13
    const bal = computeVaultBalance(raw, 1e6);
    expect(bal).toBe(0);
  });
});
