/**
 * CAS retry behaviors that the barrier-based race tests do not cover:
 *
 * 1. CDN staleness: @vercel/blob `get(..., { useCache: false })` is a silent
 *    no-op on a PUBLIC store (the SDK only appends its cache-buster for
 *    private access), so a CDN edge can keep serving the SAME stale
 *    content+etag pair for up to ~60s after a write. A retry loop without
 *    backoff burns every attempt against that identical stale pair in
 *    milliseconds and deterministically exhausts — even for strictly
 *    sequential registrations. The fix (origin-fresh `?ts=` reads + backoff
 *    between attempts) must instead converge once a fresh read lands.
 *
 * 2. Initial-create race: the very first registration (blob not created yet)
 *    writes with `allowOverwrite: false`. If a concurrent request creates the
 *    blob in between, the create fails with a generic (non-precondition)
 *    error; the loop must confirm the race by re-reading and then retry the
 *    merge via ifMatch — preserving BOTH entries.
 *
 * @vercel/blob is mocked with an in-memory store, same convention as the
 * sibling registered-markets tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let fakeStore: string | null = null;
const FAKE_BLOB_URL = 'http://fake-blob/playground/registered-markets.json';

let fakeEtagVersion = 0;

/** When set, the NEXT create-only put simulates a concurrent creator winning first. */
const createRace = { entryJson: null as string | null };

class BlobPreconditionFailedError extends Error {
  constructor() {
    super('Blob precondition failed');
    this.name = 'BlobPreconditionFailedError';
  }
}

function currentEtag(): string {
  return `etag-${fakeEtagVersion}`;
}

vi.mock('@vercel/blob', () => ({
  BlobPreconditionFailedError,

  list: vi.fn(async () => {
    if (fakeStore === null) {
      return { blobs: [] };
    }

    return {
      blobs: [
        {
          pathname: 'playground/registered-markets.json',
          url: FAKE_BLOB_URL,
        },
      ],
    };
  }),

  put: vi.fn(
    async (
      _pathname: string,
      body: unknown,
      options: {
        ifMatch?: string;
        allowOverwrite?: boolean;
      } = {},
    ) => {
      if (options.ifMatch !== undefined && options.ifMatch !== currentEtag()) {
        throw new BlobPreconditionFailedError();
      }

      if (options.allowOverwrite === false) {
        if (createRace.entryJson !== null) {
          // A concurrent request creates the blob between this caller's
          // read (which saw nothing) and its create-only write.
          fakeStore = `[${createRace.entryJson}]`;
          fakeEtagVersion += 1;
          createRace.entryJson = null;
          throw new Error('blob already exists');
        }

        if (fakeStore !== null) {
          throw new Error('blob already exists');
        }
      }

      fakeStore = String(body);
      fakeEtagVersion += 1;

      return {
        url: FAKE_BLOB_URL,
      };
    },
  ),
}));

beforeEach(() => {
  fakeEtagVersion = 0;
  fakeStore = null;
  createRace.entryJson = null;
});

const { upsertRegisteredMarket } = await import('@/lib/playground-registered-markets');
type RegisteredMarket = Awaited<ReturnType<typeof upsertRegisteredMarket>>[number];

function makeEntry(i: number): RegisteredMarket {
  return {
    slabAddress: `SLAB_${i}`,
    marketAddress: `SLAB_${i}`,
    poolAddress: `POOL_${i}`,
    dexType: 'raydium-clmm',
    symbol: null,
    label: `label-${i}`,
    mainnetCA: null,
    collateral: 'COLLATERAL_MINT',
    registeredAt: i,
  };
}

function healthyFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ etag: currentEtag() }),
    json: async () => JSON.parse(fakeStore ?? '[]'),
  })) as unknown as typeof fetch;
}

describe('registered-markets CAS retry behaviors', () => {
  it('recovers from stale CDN reads: retries back off and re-read until a fresh etag+content pair lands', async () => {
    // Seed two registrations; store is now [SLAB_1, SLAB_2] at etag-2.
    global.fetch = healthyFetch();
    await upsertRegisteredMarket(makeEntry(1));
    await upsertRegisteredMarket(makeEntry(2));
    expect(currentEtag()).toBe('etag-2');

    // The CDN edge keeps serving the pre-SLAB_2 snapshot (WITH its matching
    // stale etag) for the first two mutation reads, then origin freshness
    // kicks in. Every stale attempt must fail the ifMatch write and retry.
    const staleSnapshot = JSON.stringify([makeEntry(1)]);
    let reads = 0;
    global.fetch = vi.fn(async () => {
      reads += 1;
      if (reads <= 2) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ etag: 'etag-1' }),
          json: async () => JSON.parse(staleSnapshot),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: currentEtag() }),
        json: async () => JSON.parse(fakeStore ?? '[]'),
      };
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    const result = await upsertRegisteredMarket(makeEntry(3));
    const elapsedMs = Date.now() - startedAt;

    // Succeeded on the third (first fresh) read without losing SLAB_2.
    expect(reads).toBe(3);
    expect(result.map((m) => m.slabAddress).sort()).toEqual(['SLAB_1', 'SLAB_2', 'SLAB_3']);
    expect(
      (JSON.parse(fakeStore!) as RegisteredMarket[]).map((m) => m.slabAddress).sort(),
    ).toEqual(['SLAB_1', 'SLAB_2', 'SLAB_3']);

    // Backoff actually waited between the two failed attempts
    // (jitter floor is 50% of 150ms + 300ms = 225ms; allow timer slop).
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
  });

  it('initial-create race: create-only write loses, confirms via re-read, then merges with ifMatch — both entries survive', async () => {
    global.fetch = healthyFetch();

    // Blob does not exist yet; another request wins the create with SLAB_9
    // between our read (saw nothing) and our allowOverwrite:false put.
    createRace.entryJson = JSON.stringify(makeEntry(9));

    const result = await upsertRegisteredMarket(makeEntry(1));

    expect(result.map((m) => m.slabAddress).sort()).toEqual(['SLAB_1', 'SLAB_9']);
    expect(
      (JSON.parse(fakeStore!) as RegisteredMarket[]).map((m) => m.slabAddress).sort(),
    ).toEqual(['SLAB_1', 'SLAB_9']);
  });

  it('fails closed when the origin response carries no ETag (cannot CAS without a token)', async () => {
    global.fetch = healthyFetch();
    await upsertRegisteredMarket(makeEntry(1));

    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({}),
      json: async () => JSON.parse(fakeStore!),
    })) as unknown as typeof fetch;

    await expect(upsertRegisteredMarket(makeEntry(2))).rejects.toThrow();
    expect((JSON.parse(fakeStore!) as RegisteredMarket[]).map((m) => m.slabAddress)).toEqual([
      'SLAB_1',
    ]);
  });
});
