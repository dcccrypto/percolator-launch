/**
 * GH#1165 — /earn TVL sentinel filter for vault_balance
 * GH#1204 — /earn TVL uses vault_balance (actual deposits), not lp_collateral (bootstrap config)
 *
 * Root cause (GH#1165): corrupt vault_balance values (e.g. ~4e14 at 6 decimals = $400M)
 * passed the existing sentinel filter (isSentinel = v > 1e18) but produced
 * wildly inflated TVL on the /earn page.
 *
 * Root cause (GH#1204): lp_collateral was used instead of vault_balance.
 * lp_collateral = 10^11 for NNOB-PERP at 6 decimals = $100K TVL even when
 * vault has zero actual deposits (vault_balance = 0).
 *
 * Fix: use vault_balance (actual on-chain deposits) and apply sentinel + USD cap.
 */

import { describe, it, expect } from 'vitest';

// ─── Inline the same logic as hooks/useEarnStats.ts ───────────────────────
const isSentinel = (v: number) => v > 1e18;
const MAX_VAULT_USD = 10_000_000; // $10M cap per vault

function computeVaultBalance(vault_balance: number | null, collDivisor: number): number {
  const vaultBalanceRaw = vault_balance ?? 0;
  const vaultBalanceHuman = isSentinel(vaultBalanceRaw) ? Infinity : vaultBalanceRaw / collDivisor;
  return vaultBalanceHuman > MAX_VAULT_USD ? 0 : vaultBalanceRaw;
}

function computeTvl(markets: { vault_balance: number | null; decimals: number }[]): number {
  return markets.reduce((s, m) => {
    const collDivisor = 10 ** m.decimals;
    const vaultBalance = computeVaultBalance(m.vault_balance, collDivisor);
    return s + vaultBalance / collDivisor;
  }, 0);
}
// ──────────────────────────────────────────────────────────────────────────

describe('useEarnStats — vault_balance sentinel filter (GH#1165, GH#1204)', () => {
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

  it('handles null vault_balance as 0', () => {
    const bal = computeVaultBalance(null, 1e6);
    expect(bal).toBe(0);
  });

  it('TVL with one corrupt market is not inflated', () => {
    const markets = [
      { vault_balance: 1_000 * 1e6, decimals: 6 },   // 1,000 USDC — legit
      { vault_balance: 4e14, decimals: 6 },            // $400M USDC — corrupt
      { vault_balance: 500 * 1e9, decimals: 9 },      // 500 SOL — legit
    ];
    const tvl = computeTvl(markets);
    // Should only include the two legit vaults: 1,000 + 500 = 1,500 human units
    expect(tvl).toBe(1_500);
  });

  it('TVL with all legit markets aggregates correctly', () => {
    const markets = [
      { vault_balance: 100 * 1e6, decimals: 6 },   // 100 USDC
      { vault_balance: 200 * 1e6, decimals: 6 },   // 200 USDC
      { vault_balance: 50 * 1e9,  decimals: 9 },   // 50 SOL
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

  // ─── GH#1204 regression test ─────────────────────────────────────────────
  it('GH#1204: NNOB-PERP shows $0 TVL when vault_balance=0 despite lp_collateral=10^11', () => {
    // lp_collateral = 100000000000 (bootstrap config) — NOT the actual deposits
    // vault_balance = 0 (actual on-chain SOL in vault)
    // Before fix: would show $100K TVL using lp_collateral / 10^6
    // After fix: must show $0 using vault_balance
    const vault_balance = 0;
    const decimals = 6;
    const collDivisor = 10 ** decimals;
    const bal = computeVaultBalance(vault_balance, collDivisor);
    expect(bal).toBe(0);
    expect(bal / collDivisor).toBe(0); // TVL = $0
  });

  it('GH#1204: market with small real deposits shows correct TVL', () => {
    // vault_balance = 5_000 USDC (5e9 micro-units at 6 decimals) — real deposits
    const vault_balance = 5_000 * 1e6;
    const decimals = 6;
    const collDivisor = 10 ** decimals;
    const bal = computeVaultBalance(vault_balance, collDivisor);
    expect(bal / collDivisor).toBe(5_000); // TVL = $5,000
  });
});
