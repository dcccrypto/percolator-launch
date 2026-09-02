import { describe, expect, it } from 'vitest';
import {
  findUnseededBackingDomains,
  LAUNCH_BACKING_DOMAINS,
  type BackingBucketLike,
} from '@/lib/market-params';

/**
 * GH#2514 — the sequential launch path reported `Market created!` even when the
 * transaction carrying BOTH required backing top-ups failed. It caught the
 * error, warned to the console, and continued without ever reading the market
 * account to establish that domains 0 and 1 were seeded.
 *
 * These are the outcome cases the launch must reject. Deleting the status /
 * nonzero-backing test inside findUnseededBackingDomains makes every "rejects"
 * case below fail, which is the negative control for the fix.
 */

// Fresh(1) with real backing — what a landed TopUpBackingBucket produces.
const seeded = (domain: number): BackingBucketLike => ({
  domain,
  status: 1,
  statusName: 'Fresh',
  freshUnlienedBackingNum: 1_000_000n,
});

const withStatus = (
  domain: number,
  status: number,
  statusName: string,
  num = 1_000_000n,
): BackingBucketLike => ({ domain, status, statusName, freshUnlienedBackingNum: num });

describe('findUnseededBackingDomains (GH#2514)', () => {
  it('accepts a launch where both domains landed', () => {
    expect(findUnseededBackingDomains([seeded(0), seeded(1)])).toEqual([]);
  });

  it('rejects the reported bug: the whole top-up transaction failed', () => {
    // Neither instruction landed, so neither bucket ever left Empty.
    const missing = findUnseededBackingDomains([
      withStatus(0, 0, 'Empty', 0n),
      withStatus(1, 0, 'Empty', 0n),
    ]);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain('domain 0 (long)');
    expect(missing[1]).toContain('domain 1 (short)');
  });

  it('rejects a HALF failure, which no transaction result can distinguish', () => {
    // The single tx carries both top-ups, so this needs partial application —
    // but the point is that reading the outcome catches it and a caught throw
    // does not.
    const missing = findUnseededBackingDomains([seeded(0), withStatus(1, 0, 'Empty', 0n)]);
    expect(missing).toEqual(['domain 1 (short): Empty']);
  });

  it('rejects an absent bucket (slab too short / domain never addressable)', () => {
    expect(findUnseededBackingDomains([seeded(0)])).toEqual(['domain 1 (short): absent']);
    expect(findUnseededBackingDomains([])).toHaveLength(2);
  });

  it('rejects Expired and Impaired — neither is a usable seed', () => {
    expect(findUnseededBackingDomains([withStatus(0, 2, 'Expired'), seeded(1)]))
      .toEqual(['domain 0 (long): Expired']);
    expect(findUnseededBackingDomains([seeded(0), withStatus(1, 3, 'Impaired')]))
      .toEqual(['domain 1 (short): Impaired']);
  });

  it('rejects Fresh-but-zero: status alone is not proof of a seed', () => {
    expect(findUnseededBackingDomains([seeded(0), withStatus(1, 1, 'Fresh', 0n)]))
      .toEqual(['domain 1 (short): Fresh']);
  });

  it('ignores domains beyond the two the launch seeds', () => {
    // A multi-asset market has domains 2..2n; the launch only funds asset 0.
    expect(
      findUnseededBackingDomains([
        seeded(0),
        seeded(1),
        withStatus(2, 0, 'Empty', 0n),
        withStatus(3, 0, 'Empty', 0n),
      ]),
    ).toEqual([]);
  });

  it('checks exactly the asset-0 long/short pair', () => {
    expect(LAUNCH_BACKING_DOMAINS).toEqual([0, 1]);
  });
});
