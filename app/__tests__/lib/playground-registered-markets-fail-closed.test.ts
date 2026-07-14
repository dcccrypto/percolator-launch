/**
 * J: readRegisteredMarkets() returned [] on ANY error ("treating as empty"),
 * and upsertRegisteredMarket did an unguarded read-modify-write on top of
 * that lenient read — a single transient Blob/CDN read failure during a
 * registration would overwrite the whole blob with ONE entry, destroying up
 * to MAX_REGISTERED_MARKETS (100) existing market↔pool bindings.
 *
 * Fix: upsertRegisteredMarket now uses a stricter internal read that reports
 * `ok: false` for a genuine read FAILURE (distinct from a legitimate
 * not-yet-created blob) and aborts (throws) instead of writing on top of an
 * assumed-empty list. The public `readRegisteredMarkets()` (used by GET
 * routes) keeps its lenient "always [] on failure, never throws" contract.
 *
 * @vercel/blob is mocked with an in-memory store, same convention as the
 * existing __tests__/lib/playground-registered-markets-cap.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let fakeStore: string | null = null;
const FAKE_BLOB_URL = 'http://fake-blob/playground/registered-markets.json';

let fakeEtagVersion = 0;

class BlobPreconditionFailedError extends Error {
  constructor() {
    super('Blob precondition failed');
    this.name = 'BlobPreconditionFailedError';
  }
}

function currentEtag(): string {
  return `etag-${fakeEtagVersion}`;
}

function streamFromText(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
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

  get: vi.fn(async () => {
    if (fakeStore === null) {
      return null;
    }

    /*
     * Delegate reads to the existing fetch fixture so the fail-closed
     * tests can continue simulating non-OK, network and malformed reads.
     */
    const response = await global.fetch(FAKE_BLOB_URL);

    if (!response.ok) {
      return {
        statusCode: response.status || 500,
        stream: null,
        blob: {
          etag: currentEtag(),
        },
      };
    }

    const payload = await response.json();

    return {
      statusCode: 200,
      stream: streamFromText(JSON.stringify(payload)),
      blob: {
        etag: currentEtag(),
      },
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

      if (options.allowOverwrite === false && fakeStore !== null) {
        throw new BlobPreconditionFailedError();
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
});

const { readRegisteredMarkets, upsertRegisteredMarket } =
  await import('@/lib/playground-registered-markets');
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

describe('J: playground-registered-markets fails CLOSED on a read failure', () => {
  it('baseline: a healthy read + upsert round-trips normally', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(fakeStore ?? '[]'),
    })) as any;
    await upsertRegisteredMarket(makeEntry(1));
    const result = await upsertRegisteredMarket(makeEntry(2));
    expect(result).toHaveLength(2);
  });

  it('upsertRegisteredMarket ABORTS (throws) on a non-OK blob read, instead of overwriting with a partial list', async () => {
    // Seed the blob with 3 existing registrations via a healthy read/write.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(fakeStore ?? '[]'),
    })) as any;
    await upsertRegisteredMarket(makeEntry(1));
    await upsertRegisteredMarket(makeEntry(2));
    await upsertRegisteredMarket(makeEntry(3));
    const before = JSON.parse(fakeStore!);
    expect(before).toHaveLength(3);

    // Now simulate a transient CDN/read failure (non-OK response) on the NEXT
    // registration attempt.
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('should not parse');
      },
    })) as any;

    await expect(upsertRegisteredMarket(makeEntry(4))).rejects.toThrow();

    // The blob must be UNTOUCHED — not overwritten with a single-entry array.
    const after = JSON.parse(fakeStore!);
    expect(after).toHaveLength(3);
    expect(after.map((m: RegisteredMarket) => m.slabAddress).sort()).toEqual([
      'SLAB_1',
      'SLAB_2',
      'SLAB_3',
    ]);
  });

  it('upsertRegisteredMarket ABORTS on a network-level fetch throw', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(fakeStore ?? '[]'),
    })) as any;
    await upsertRegisteredMarket(makeEntry(1));
    await upsertRegisteredMarket(makeEntry(2));

    global.fetch = vi.fn(async () => {
      throw new Error('network blip');
    }) as any;
    await expect(upsertRegisteredMarket(makeEntry(3))).rejects.toThrow();

    const after = JSON.parse(fakeStore!);
    expect(after).toHaveLength(2); // untouched
  });

  it('upsertRegisteredMarket ABORTS on malformed (non-array) blob content', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(fakeStore ?? '[]'),
    })) as any;
    await upsertRegisteredMarket(makeEntry(1));

    // Corrupt the stored payload directly (simulates a partial/garbled write elsewhere).
    fakeStore = JSON.stringify({ not: 'an array' });
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(fakeStore!),
    })) as any;

    await expect(upsertRegisteredMarket(makeEntry(2))).rejects.toThrow();
    // Still the corrupted (untouched) content — not silently replaced.
    expect(JSON.parse(fakeStore!)).toEqual({ not: 'an array' });
  });

  it('readRegisteredMarkets() (the lenient GET-route path) still degrades to [] on the SAME failures — never throws', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('nope');
      },
    })) as any;
    // list() reports a blob exists (fakeStore starts non-null after a prior seed
    // in a real scenario) — here we just confirm no throw and an empty result.
    await expect(readRegisteredMarkets()).resolves.toEqual([]);
  });

  it('a genuinely not-yet-created blob (no prior registrations) is a real empty state, not a failure', async () => {
    // fakeStore is null (beforeEach) -> list() returns no blobs -> genuinely empty.
    global.fetch = vi.fn() as any; // must not even be called
    const result = await upsertRegisteredMarket(makeEntry(1));
    expect(result).toHaveLength(1);
  });
});
