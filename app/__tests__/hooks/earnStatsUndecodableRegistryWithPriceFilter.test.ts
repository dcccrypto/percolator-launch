/**
 * #3219 (an undecodable registry is an UNVALUED vault, not $0) together with #3239/#3269 (Earn hides
 * live markets with no price source; an entry with no row stays listed). Both behaviours must hold at
 * once: the registry-read change marks `found: true, unvalued: true`, which must not resurrect a
 * placeholder launch the price-source filter removed, and must not hide a priced vault.
 */
import { describe, it, expect } from 'vitest';
import { buildLiveMarkets, computeAggregates, type CuratedVaultOnChain } from '@/hooks/useEarnStats';

const POOL = '9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg';
const live = (slab: string, row?: Record<string, unknown>) => ({ slabAddress: slab, symbol: String(row?.symbol ?? slab), name: slab, mainnetCa: null, row });
const UNDECODED: CuratedVaultOnChain = { tvlAtoms: 0n, cooldownSlots: 0n, found: true, unvalued: true };

describe('undecodable registry + no-price-source filter', () => {
  const vaults: Record<string, CuratedVaultOnChain> = {
    PRICED: UNDECODED,
    NOPOOL: UNDECODED,
    NOROW: UNDECODED,
    GOOD: { tvlAtoms: 5_000_000n, cooldownSlots: 0n, found: true },
  };
  const markets = buildLiveMarkets(
    [
      live('PRICED', { symbol: 'AAA', dex_pool_address: POOL }),
      live('NOPOOL', { symbol: 'UNKNOWN', dex_pool_address: null }),
      live('NOROW'),
      live('GOOD', { symbol: 'BBB', dex_pool_address: POOL }),
    ],
    new Set(['PRICED', 'NOPOOL', 'NOROW', 'GOOD']),
    vaults,
  );

  it('a priced market with an undecodable registry stays listed, unvalued, with a $0 balance', () => {
    const m = markets.find((x) => x.slabAddress === 'PRICED');
    expect(m).toMatchObject({ hasVault: true, unvalued: true, vaultBalance: 0 });
  });

  it('a no-price-source placeholder is still hidden even though its registry is unvalued', () => {
    expect(markets.map((x) => x.slabAddress)).not.toContain('NOPOOL');
  });

  it('an entry with no row stays listed (and does not throw) and is unvalued', () => {
    expect(markets.find((x) => x.slabAddress === 'NOROW')).toMatchObject({ unvalued: true });
  });

  it('the aggregate names the unvalued vaults and counts only the valued one in TVL', () => {
    const agg = computeAggregates(markets);
    expect([...agg.unvaluedSymbols].sort()).toEqual(['AAA', 'NOROW']);
    expect(agg.tvl).toBeGreaterThan(0);
    expect(agg.tvl).toBe(markets.find((x) => x.slabAddress === 'GOOD')!.vaultBalance / 10 ** markets.find((x) => x.slabAddress === 'GOOD')!.decimals);
  });
});
