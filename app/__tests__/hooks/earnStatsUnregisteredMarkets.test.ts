/**
 * 2026-10-06: ~30 launches whose keeper registration never landed were listed in Earn as
 * "UNKNOWN" vaults (indexer placeholder rows: symbol UNKNOWN, no dex_pool_address). They cannot be
 * priced, and /markets already hides them (isListedMarketRow), so Earn must too.
 */
import { describe, it, expect } from 'vitest';
import { buildLiveMarkets, type CuratedVaultOnChain } from '@/hooks/useEarnStats';

const POOL = '9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg';
const live = (slab: string, row: Record<string, unknown>) => ({ slabAddress: slab, symbol: String(row.symbol ?? slab), name: slab, mainnetCa: null, row });
const found = (slabs: string[]): Record<string, CuratedVaultOnChain> =>
  Object.fromEntries(slabs.map((s) => [s, { tvlAtoms: 5_000_000n, cooldownSlots: 0n, found: true }]));

describe('buildLiveMarkets: unregistered launches are not vaults', () => {
  it('drops a placeholder row with an explicit null/empty pool, keeps registered ones', () => {
    const rows = [
      live('REG', { symbol: 'PLAGUE', dex_pool_address: POOL }),
      live('NOPOOL', { symbol: 'UNKNOWN', dex_pool_address: null }),
      live('EMPTY', { symbol: 'UNKNOWN', dex_pool_address: '' }),
    ];
    const m = buildLiveMarkets(rows, new Set(['REG', 'NOPOOL', 'EMPTY']), found(['REG', 'NOPOOL', 'EMPTY']));
    expect(m.map((x) => x.slabAddress)).toEqual(['REG']);
  });

  it('a row that does not carry the field at all stays listed (unknown is not "no pool")', () => {
    const m = buildLiveMarkets([live('X', { symbol: 'X' })], new Set(['X']), found(['X']));
    expect(m).toHaveLength(1);
  });
});
