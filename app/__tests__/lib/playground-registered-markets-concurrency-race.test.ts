import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deterministic lost-update PoC.
 *
 * Both concurrent registrations are forced to read the same registry snapshot.
 * Their writes are then committed in a deterministic A -> B order.
 *
 * A correct implementation must preserve both registrations.
 * The current read-modify-write implementation instead allows B to overwrite A.
 */

const state = vi.hoisted(() => ({
  fakeStore: '[]',
  fakeEtagVersion: 0,
  readArrivals: 0,
  readSnapshots: [] as string[],
  writeBodies: [] as string[][],

  allReadsArrived: Promise.resolve(),
  releaseReads: () => {},

  firstWriteDone: Promise.resolve(),
  releaseFirstWrite: () => {},
}));

vi.mock('@vercel/blob', () => {
  class BlobPreconditionFailedError extends Error {
    constructor() {
      super('Blob precondition failed');
      this.name = 'BlobPreconditionFailedError';
    }
  }

  const currentEtag = () => `etag-${state.fakeEtagVersion}`;

  const streamFromText = (value: string): ReadableStream<Uint8Array> => {
    const bytes = new TextEncoder().encode(value);

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  };

  return {
    BlobPreconditionFailedError,

    list: vi.fn(async () => ({
      blobs: [
        {
          pathname: 'playground/registered-markets.json',
          url: 'https://blob.test/playground/registered-markets.json',
        },
      ],
    })),

    get: vi.fn(async () => {
      /*
       * Force both initial mutation reads to observe the same content and ETag.
       * Retry reads are allowed through immediately and observe the latest state.
       */
      const capturedSnapshot = state.fakeStore;
      const capturedEtag = currentEtag();

      if (state.readArrivals < 2) {
        state.readArrivals += 1;
        state.readSnapshots.push(capturedSnapshot);

        if (state.readArrivals === 2) {
          state.releaseReads();
        }

        await state.allReadsArrived;
      } else {
        state.readSnapshots.push(capturedSnapshot);
      }

      return {
        statusCode: 200,
        stream: streamFromText(capturedSnapshot),
        blob: {
          etag: capturedEtag,
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
        const nextRegistry = JSON.parse(String(body)) as Array<{
          slabAddress?: string;
        }>;

        const slabs = nextRegistry
          .map((entry) => entry.slabAddress)
          .filter((slab): slab is string => typeof slab === 'string');

        const containsA = slabs.includes('race-market-a');
        const containsB = slabs.includes('race-market-b');

        /*
         * Deterministically let A commit first. B's stale first attempt then
         * reaches the conditional write only after A changed the ETag.
         */
        if (containsB && !containsA) {
          await state.firstWriteDone;
        }

        if (options.ifMatch !== undefined && options.ifMatch !== currentEtag()) {
          throw new BlobPreconditionFailedError();
        }

        if (options.allowOverwrite === false && state.fakeStore !== '[]') {
          throw new BlobPreconditionFailedError();
        }

        state.fakeStore = JSON.stringify(nextRegistry);
        state.writeBodies.push(slabs);
        state.fakeEtagVersion += 1;

        if (containsA && !containsB) {
          state.releaseFirstWrite();
        }

        return {
          url: 'https://blob.test/playground/registered-markets.json',
          etag: currentEtag(),
        };
      },
    ),
  };
});

const { upsertRegisteredMarket } = await import('@/lib/playground-registered-markets');

type RegisteredMarket = Parameters<typeof upsertRegisteredMarket>[0];

function makeEntry(slabAddress: string): RegisteredMarket {
  const suffix = slabAddress.endsWith('-a') ? 'a' : 'b';

  return {
    slabAddress,
    marketAddress: slabAddress,
    poolAddress: `race-pool-${suffix}`,
    dexType: 'raydium-clmm',
    symbol: `RACE-${suffix.toUpperCase()}`,
    label: `Race market ${suffix}`,
    mainnetCA: null,
    collateral: 'race-collateral',
    registeredAt: suffix === 'a' ? 1 : 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  state.fakeStore = '[]';
  state.fakeEtagVersion = 0;
  state.readArrivals = 0;
  state.readSnapshots.length = 0;
  state.writeBodies.length = 0;

  state.allReadsArrived = new Promise<void>((resolve) => {
    state.releaseReads = resolve;
  });

  state.firstWriteDone = new Promise<void>((resolve) => {
    state.releaseFirstWrite = resolve;
  });

  global.fetch = vi.fn(async () => {
    /*
     * Capture the snapshot before waiting at the barrier.
     * Therefore both requests deterministically retain the same stale value.
     */
    const capturedSnapshot = state.fakeStore;

    state.readSnapshots.push(capturedSnapshot);
    state.readArrivals += 1;

    if (state.readArrivals === 2) {
      state.releaseReads();
    }

    await state.allReadsArrived;

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(capturedSnapshot),
    } as Response;
  });
});

describe('registered-markets concurrent upsert safety', () => {
  it('preserves both registrations when concurrent requests read the same snapshot', async () => {
    await Promise.all([
      upsertRegisteredMarket(makeEntry('race-market-a')),
      upsertRegisteredMarket(makeEntry('race-market-b')),
    ]);

    const finalRegistry = JSON.parse(state.fakeStore) as Array<{
      slabAddress?: string;
    }>;

    const finalSlabs = finalRegistry
      .map((entry) => entry.slabAddress)
      .filter((slab): slab is string => typeof slab === 'string')
      .sort();

    console.info(
      '[registered-markets concurrency PoC]',
      JSON.stringify(
        {
          readsObserved: state.readArrivals,
          readSnapshots: state.readSnapshots.map((snapshot) => JSON.parse(snapshot)),
          committedWrites: state.writeBodies,
          finalRegistry: finalSlabs,
        },
        null,
        2,
      ),
    );

    /*
     * Safety invariant:
     * every successful concurrent registration must remain discoverable.
     *
     * This assertion is expected to FAIL on the vulnerable implementation
     * because the second overwrite removes race-market-a.
     */
    expect(finalSlabs).toEqual(['race-market-a', 'race-market-b']);
  });
});
