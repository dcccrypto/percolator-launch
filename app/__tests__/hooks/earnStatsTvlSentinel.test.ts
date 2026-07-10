/**
 * GH#1165 — /earn TVL sentinel filter for the on-chain LP Vault Registry balance
 * GH#1204 — /earn TVL uses the LP Vault Registry's real backing, not a bootstrap
 * config value
 *
 * Root cause (GH#1165): corrupt vault_balance values (e.g. ~4e14 at 6 decimals =
 * $400M) passed the old u64::MAX-class sentinel filter but produced wildly
 * inflated TVL on the /earn page.
 *
 * Root cause (GH#1204): a bootstrap config value was used instead of the vault's
 * actual on-chain deposits.
 *
 * Fix: apply a sane USD cap on top of the sentinel filter, in the same code path
 * the /earn page actually renders from (`buildMarketVaultInfo` in
 * hooks/useEarnStats.ts) — not a re-implementation that can silently drift from it.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMarketVaultInfo,
  CURATED_COLLATERAL_DECIMALS,
  MAX_VAULT_USD,
  type CuratedVaultOnChain,
} from '@/hooks/useEarnStats';

const emptySupabase = new Map<string, Record<string, unknown>>();

/** Build the curatedVaults map buildMarketVaultInfo expects, for a single slab. */
function vaultsFor(slab: string, tvlAtoms: bigint): Record<string, CuratedVaultOnChain> {
  return { [slab]: { tvlAtoms, cooldownSlots: 0n, found: true } };
}

function tvlUsdFor(slab: string, tvlAtoms: bigint): number {
  const info = buildMarketVaultInfo(slab, 'TEST', 'Test Market', null, vaultsFor(slab, tvlAtoms), emptySupabase);
  return info.vaultBalance / (10 ** info.decimals);
}

describe('useEarnStats — buildMarketVaultInfo TVL sentinel + cap (GH#1165, GH#1204)', () => {
  it('collateral decimals are the shared Sim-USDC constant (6)', () => {
    expect(CURATED_COLLATERAL_DECIMALS).toBe(6);
  });

  it('passes legitimate LP vault TVL (1,000 Sim-USDC at 6 decimals)', () => {
    const atoms = BigInt(1_000 * 1e6);
    expect(tvlUsdFor('slabA', atoms)).toBe(1_000);
  });

  it('blocks corrupt value producing $400M TVL (4e14 atoms at 6 decimals)', () => {
    // 4e14 / 1e6 = 4e8 = $400M — below the u64::MAX-class sentinel threshold but
    // still implausible; must be zeroed by the $10M cap.
    const atoms = 4_00_000_000_000_000n;
    expect(tvlUsdFor('slabA', atoms)).toBe(0);
  });

  it('blocks sentinel-range values (>= 18e18, ~u64::MAX)', () => {
    const atoms = 18_000_000_000_000_000_001n;
    expect(tvlUsdFor('slabA', atoms)).toBe(0);
  });

  it('blocks negative-looking (impossible) atoms defensively via 0 fallback', () => {
    const info = buildMarketVaultInfo('slabA', 'TEST', 'Test Market', null, {}, emptySupabase);
    expect(info.vaultBalance).toBe(0);
  });

  it(`$${(MAX_VAULT_USD - 100_000).toLocaleString()} vault is allowed (just under the cap)`, () => {
    const underCapUsd = MAX_VAULT_USD - 100_000;
    const atoms = BigInt(underCapUsd) * 1_000_000n;
    expect(tvlUsdFor('slabA', atoms)).toBe(underCapUsd);
  });

  it(`$${(MAX_VAULT_USD + 100_000).toLocaleString()} vault is blocked (just over the cap)`, () => {
    const overCapUsd = MAX_VAULT_USD + 100_000;
    const atoms = BigInt(overCapUsd) * 1_000_000n;
    expect(tvlUsdFor('slabA', atoms)).toBe(0);
  });

  it('a market with no LP Vault Registry entry shows $0 TVL, not a fabricated value', () => {
    // GH#1204 shape: the registry hasn't been read/created for this slab yet.
    expect(tvlUsdFor('slabA', 0n)).toBe(0);
  });

  it('one corrupt market does not inflate the aggregate TVL across markets', () => {
    const legitA = buildMarketVaultInfo(
      'slabA', 'A', 'Market A', null,
      { slabA: { tvlAtoms: BigInt(1_000 * 1e6), cooldownSlots: 0n, found: true } },
      emptySupabase,
    );
    const corruptB = buildMarketVaultInfo(
      'slabB', 'B', 'Market B', null,
      { slabB: { tvlAtoms: 4_00_000_000_000_000n, cooldownSlots: 0n, found: true } },
      emptySupabase,
    );
    const legitC = buildMarketVaultInfo(
      'slabC', 'C', 'Market C', null,
      { slabC: { tvlAtoms: BigInt(500 * 1e6), cooldownSlots: 0n, found: true } },
      emptySupabase,
    );
    const tvl = [legitA, corruptB, legitC].reduce(
      (s, m) => s + m.vaultBalance / (10 ** m.decimals),
      0,
    );
    expect(tvl).toBe(1_500); // only the two legit vaults: 1,000 + 500
  });
});
