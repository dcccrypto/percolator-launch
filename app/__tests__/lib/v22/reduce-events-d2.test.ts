// @vitest-environment node
/** D2 gate: the wallet screen's rows for "position reduced without your order" events (indexer v22_events kind reduce_event). */
import { describe, expect, it } from 'vitest';
import {
  toReduceEventView,
  parsePortfolioList,
  REDUCE_EVENTS_MAX_PORTFOLIOS,
} from '@/lib/v22/reduce-events';
import { REDUCE_NOTICE_COPY } from '@/lib/v22/reduce-copy';

const P = 'AXa339sRttD8mdHUyDdGbGQyZNQnR17fFKzg9P5Ui5ym';
const M = '9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn';
const row = (reason: number, over: Record<string, unknown> = {}) => ({
  signature: '5sig',
  ix_index: 0,
  inner_index: 1000000,
  kind: 'reduce_event',
  slab_address: M,
  asset_index: 0,
  actor: P,
  amount: '1500',
  block_time: '2026-10-29T10:00:00Z',
  slot: 123,
  detail: { reason, signed_reduced_q: '-1500', price_e6: '2500000' },
  ...over,
});

describe('toReduceEventView', () => {
  it('an LP stop reads the LP-stop line, flagged as such, with size and price', () => {
    const v = toReduceEventView(row(8));
    expect(v).toEqual({
      signature: '5sig',
      ixIndex: 0,
      innerIndex: 1000000,
      market: M,
      portfolio: P,
      at: '2026-10-29T10:00:00Z',
      slot: 123,
      reason: 8,
      lpStop: true,
      title: REDUCE_NOTICE_COPY[8].title,
      body: REDUCE_NOTICE_COPY[8].body,
      reducedQ: '1500',
      priceE6: '2500000',
    });
  });
  it('every involuntary reason maps to its plain line; only reason 8 is an LP stop', () => {
    for (const r of [2, 3, 4, 5, 6]) {
      const v = toReduceEventView(row(r));
      expect(v?.body).toBe(REDUCE_NOTICE_COPY[r].body);
      expect(v?.lpStop).toBe(false);
    }
  });
  it("the trader's own reduces (1 rebalance-reduce, 7 owner-signed resolved close) are not 'without your order'", () => {
    expect(toReduceEventView(row(1))).toBeNull();
    expect(toReduceEventView(row(7))).toBeNull();
  });
  it('an unknown reason is listed generically with its number, not hidden and not given made-up words', () => {
    const v = toReduceEventView(row(99))!;
    expect(v).not.toBeNull();
    expect(v.reason).toBe(99);
    expect(v.lpStop).toBe(false);
    expect(v.title).toBe('Position reduced (reason 99)');
    expect(v.body).toBe('Your position was reduced for a reason this app does not describe yet.');
  });
  it('other kinds and malformed rows are dropped', () => {
    expect(toReduceEventView(row(8, { kind: 'fill_event' }))).toBeNull();
    expect(toReduceEventView(row(8, { detail: null }))).toBeNull();
    expect(toReduceEventView(row(8, { signature: null }))).toBeNull();
  });
});

describe('parsePortfolioList', () => {
  it('keeps valid, distinct addresses up to the cap', () => {
    expect(parsePortfolioList(`${P},${P}, ${M}`)).toEqual([P, M]);
    expect(parsePortfolioList('not-a-key,' + P)).toEqual([P]);
    expect(parsePortfolioList(null)).toEqual([]);
    const many = Array.from({ length: REDUCE_EVENTS_MAX_PORTFOLIOS + 5 }, (_, i) => {
      const b = new Uint8Array(32);
      b[0] = i + 1;
      return b;
    })
      .map((b) => new (require('@solana/web3.js').PublicKey)(b).toBase58())
      .join(',');
    expect(parsePortfolioList(many)).toHaveLength(REDUCE_EVENTS_MAX_PORTFOLIOS);
  });
});

import { fetchReduceEvents, compareNewestFirst } from '@/lib/v22/reduce-events';
describe('fetchReduceEvents', () => {
  const v = (sig: string, at: string, portfolio = P) => ({
    ...toReduceEventView(row(8, { signature: sig, block_time: at, actor: portfolio }))!,
  });
  it('chunks by the cap, merges newest first, drops duplicates', async () => {
    const ps = Array.from({ length: REDUCE_EVENTS_MAX_PORTFOLIOS + 1 }, (_, i) => `p${i}`);
    const urls: string[] = [];
    const out = await fetchReduceEvents('W', ps, async (url) => {
      urls.push(url);
      return urls.length === 1
        ? {
            available: true,
            events: [v('a', '2026-10-29T09:00:00Z'), v('b', '2026-10-29T11:00:00Z')],
          }
        : {
            available: true,
            events: [v('a', '2026-10-29T09:00:00Z'), v('c', '2026-10-29T10:00:00Z')],
          };
    });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(
      `/api/trader/W/reduce-events?portfolios=${ps.slice(0, REDUCE_EVENTS_MAX_PORTFOLIOS).join(',')}`,
    );
    expect(out).toEqual({
      available: true,
      events: [
        v('b', '2026-10-29T11:00:00Z'),
        v('c', '2026-10-29T10:00:00Z'),
        v('a', '2026-10-29T09:00:00Z'),
      ],
    });
  });
  it("one chunk failing or unavailable makes the whole answer 'unavailable', keeping what did load", async () => {
    const ps = Array.from({ length: REDUCE_EVENTS_MAX_PORTFOLIOS + 1 }, (_, i) => `p${i}`);
    let n = 0;
    const out = await fetchReduceEvents('W', ps, async () =>
      ++n === 1 ? { available: true, events: [v('a', '2026-10-29T09:00:00Z')] } : null,
    );
    expect(out.available).toBe(false);
    expect(out.events).toHaveLength(1);
    const thrown = await fetchReduceEvents('W', ['p'], async () => {
      throw new Error('net');
    });
    expect(thrown).toEqual({ available: false, events: [] });
  });
});

describe('ordering with missing block times', () => {
  const v = (sig: string, at: string | null, slot: number | null) =>
    toReduceEventView(row(8, { signature: sig, block_time: at, slot }))!;
  it('a row with no block time sorts after every timed row; untimed rows order by slot', async () => {
    const rows = [
      v('nt-lo', null, 10),
      v('old', '2026-10-01T00:00:00Z', 1),
      v('nt-hi', null, 99),
      v('new', '2026-10-29T00:00:00Z', 2),
    ];
    const out = await fetchReduceEvents('W', ['p'], async () => ({
      available: true,
      events: rows,
    }));
    expect(out.events.map((e) => e.signature)).toEqual(['new', 'old', 'nt-hi', 'nt-lo']);
  });
  it('same time: higher slot first', () => {
    expect(
      compareNewestFirst(v('a', '2026-10-29T00:00:00Z', 5), v('b', '2026-10-29T00:00:00Z', 9)),
    ).toBeGreaterThan(0);
  });
});
