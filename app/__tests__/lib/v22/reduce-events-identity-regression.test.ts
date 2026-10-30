// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { fetchReduceEvents, toReduceEventView } from '@/lib/v22/reduce-events';

const makeEvent = (signature: string, reason: number, innerIndex: number) => {
  const event = toReduceEventView({
    signature,
    ix_index: 2,
    inner_index: innerIndex,
    kind: 'reduce_event',
    actor: 'portfolio-A',
    slab_address: 'market-A',
    asset_index: 0,
    amount: '100',
    slot: 42,
    block_time: '2026-10-30T00:00:00Z',
    detail: { reason, price_e6: '1000000' },
  });

  if (!event) throw new Error('Test fixture rejected');
  return event;
};

const fetchRows = async (rows: ReturnType<typeof makeEvent>[]) =>
  fetchReduceEvents('wallet-A', ['portfolio-A'], async () => ({
    available: true,
    events: rows,
  }));

describe('V22 reduction event identity', () => {
  it('positive control: distinct transactions survive', async () => {
    const result = await fetchRows([makeEvent('tx-A', 6, 1000000), makeEvent('tx-B', 8, 1000000)]);

    expect(result.events).toHaveLength(2);
  });

  it('negative control: an identical event is deduplicated', async () => {
    const event = makeEvent('tx-A', 6, 1000000);

    const result = await fetchRows([event, event]);

    expect(result.events).toHaveLength(1);
  });

  it('regression: distinct events sharing a transaction and portfolio survive', async () => {
    const result = await fetchRows([
      makeEvent('tx-shared', 6, 1000000),
      makeEvent('tx-shared', 8, 1000001),
    ]);

    expect(result.events).toHaveLength(2);
    expect(result.events.map((e) => e.reason).sort()).toEqual([6, 8]);
  });
});

describe('V22 reduction identity edge controls', () => {
  it('preserves different instructions sharing a transaction and inner index', async () => {
    const first = makeEvent('tx-shared-ix', 6, 1000000);
    const second = {
      ...makeEvent('tx-shared-ix', 8, 1000000),
      ixIndex: first.ixIndex + 1,
    };

    const result = await fetchRows([first, second]);

    expect(result.available).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.ixIndex).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(result.events.map((event) => event.reason).sort()).toEqual([6, 8]);
  });

  it('rejects malformed instruction and inner indexes', () => {
    const validRow = {
      signature: 'tx-invalid-index',
      ix_index: 2,
      inner_index: 1000000,
      kind: 'reduce_event',
      actor: 'portfolio-A',
      slab_address: 'market-A',
      asset_index: 0,
      amount: '100',
      slot: 42,
      block_time: '2026-10-30T00:00:00Z',
      detail: { reason: 6, price_e6: '1000000' },
    };

    expect(toReduceEventView({ ...validRow, ix_index: 0, inner_index: 0 })).not.toBeNull();

    const invalidValues: unknown[] = [
      null,
      undefined,
      -1,
      1.5,
      '2',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    for (const invalid of invalidValues) {
      expect(toReduceEventView({ ...validRow, ix_index: invalid })).toBeNull();
      expect(toReduceEventView({ ...validRow, inner_index: invalid })).toBeNull();
    }
  });

  it('deduplicates identical event identities across portfolio batches', async () => {
    const event = makeEvent('tx-cross-batch', 8, 1000000);
    const portfolios = Array.from({ length: 26 }, (_, index) => `portfolio-${index}`);

    const requests: string[] = [];
    const result = await fetchReduceEvents('wallet-A', portfolios, async (url) => {
      requests.push(url);
      return { available: true, events: [event] };
    });

    expect(requests).toHaveLength(2);
    expect(result.available).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].signature).toBe('tx-cross-batch');
  });
});
