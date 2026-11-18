import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config', () => ({
  getAllProgramIds: vi.fn(() => []),
  getMarketDiscoveryProgramIds: vi.fn(() => []),
  getNetwork: vi.fn(() => 'devnet'),
}));

import {
  loadPortfolioShared,
  peekPortfolioSnapshot,
  type PortfolioSnapshot,
} from '@/hooks/usePortfolio';

const snap = (tag: string) => ({ tag }) as unknown as PortfolioSnapshot;
const T0 = new Date('2026-11-18T12:00:00Z').getTime();

describe('portfolio snapshot cache vs wall-clock steps', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('seed: ages normally when the clock moves forward (control)', async () => {
    const key = 'devnet:clock-fwd';
    const s = snap('a');
    await loadPortfolioShared(key, true, async () => s);
    vi.setSystemTime(T0 + 60_000);
    expect(peekPortfolioSnapshot(key)).toBe(s);
    vi.setSystemTime(T0 + 5 * 60_000 + 1);
    expect(peekPortfolioSnapshot(key)).toBeNull();
  });

  it('seed: a clock stepped backwards past the max age is not treated as fresh', async () => {
    const key = 'devnet:clock-back-seed';
    await loadPortfolioShared(key, true, async () => snap('old'));
    // e.g. NTP correction / manual change / VM resume: wall clock goes back 1 hour
    vi.setSystemTime(T0 - 60 * 60_000);
    expect(peekPortfolioSnapshot(key)).toBeNull();
  });

  it('cache hit: a clock stepped backwards does not replay the old snapshot', async () => {
    const key = 'devnet:clock-back-hit';
    const old = snap('old');
    const fresh = snap('fresh');
    await loadPortfolioShared(key, true, async () => old);
    vi.setSystemTime(T0 - 60 * 60_000);
    const fetcher = vi.fn(async () => fresh);
    const got = await loadPortfolioShared(key, false, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(got).toBe(fresh);
  });

  it('cache hit: still deduplicates inside the TTL when the clock is normal', async () => {
    const key = 'devnet:clock-ok-hit';
    const s = snap('s');
    await loadPortfolioShared(key, true, async () => s);
    vi.setSystemTime(T0 + 5_000);
    const fetcher = vi.fn(async () => snap('x'));
    expect(await loadPortfolioShared(key, false, fetcher)).toBe(s);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
