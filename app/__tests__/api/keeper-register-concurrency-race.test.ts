import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Route-level deterministic lost-update PoC.
 *
 * Two authenticated keeper-register requests:
 *
 *   1. pass route validation,
 *   2. pass mocked on-chain ownership verification,
 *   3. both read the same registered-markets snapshot,
 *   4. both return HTTP 200 / registered: true,
 *   5. but the second Blob overwrite removes the first market.
 */

const state = vi.hoisted(() => ({
  adminSecret: 'route-race-admin-secret',
  deployer: 'Vote111111111111111111111111111111111111111',
  programId: 'BPFLoaderUpgradeab1e11111111111111111111111',

  slabA: '11111111111111111111111111111111',
  slabB: 'So11111111111111111111111111111111111111112',

  poolA: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  poolB: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',

  fakeStore: '[]',
  fakeEtagVersion: 0,

  registrationReads: 0,
  readSnapshots: [] as string[],
  committedWrites: [] as string[][],

  allRegistrationReadsArrived: Promise.resolve(),
  releaseRegistrationReads: () => {},

  firstWriteCommitted: Promise.resolve(),
  releaseFirstWrite: () => {},
}));

const originalEnv = {
  NEXT_PUBLIC_DEFAULT_NETWORK: process.env.NEXT_PUBLIC_DEFAULT_NETWORK,
  NEXT_PUBLIC_SOLANA_NETWORK: process.env.NEXT_PUBLIC_SOLANA_NETWORK,
  ADMIN_API_SECRET: process.env.ADMIN_API_SECRET,
  MAINNET_RPC_URL: process.env.MAINNET_RPC_URL,
};

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = 'devnet';
delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
process.env.ADMIN_API_SECRET = state.adminSecret;
process.env.MAINNET_RPC_URL = 'https://mainnet.test';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => ({
    rpcUrl: 'https://devnet.test',
  })),

  getAllProgramIds: vi.fn(() => [state.programId]),
}));

vi.mock('@solana/web3.js', () => {
  class PublicKey {
    private readonly value: string;

    constructor(value: string) {
      this.value = value;
    }

    toBase58(): string {
      return this.value;
    }

    toBytes(): Uint8Array {
      return new Uint8Array(32);
    }
  }

  class Connection {
    private readonly endpoint: string;

    constructor(endpoint: string) {
      this.endpoint = endpoint;
    }

    async getAccountInfo(): Promise<unknown> {
      /*
       * Devnet lookup verifies the playground slab.
       */
      if (this.endpoint === 'https://devnet.test') {
        return {
          owner: {
            toBase58: () => state.programId,
          },
          data: new Uint8Array(512),
        };
      }

      /*
       * Force classifyPoolByOwner() into its documented dexType
       * fallback path. The body supplies dexType: "raydium-clmm".
       */
      throw new Error('mock mainnet RPC unavailable');
    }
  }

  return {
    Connection,
    PublicKey,
  };
});

vi.mock('@percolatorct/sdk', () => ({
  V17_HEADER_LEN: 16,

  isV17Account: vi.fn(() => false),

  parseHeader: vi.fn(() => ({
    admin: {
      toBase58: () => state.deployer,
    },
  })),

  parseWrapperConfigV17: vi.fn(() => ({
    marketauth: {
      toBase58: () => state.deployer,
    },
  })),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('@vercel/blob', () => {
  class BlobPreconditionFailedError extends Error {
    constructor() {
      super('Blob precondition failed');
      this.name = 'BlobPreconditionFailedError';
    }
  }

  const currentEtag = () => `etag-${state.fakeEtagVersion}`;

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
          .map((market) => market.slabAddress)
          .filter((slab): slab is string => typeof slab === 'string');

        const containsA = slabs.includes(state.slabA);
        const containsB = slabs.includes(state.slabB);

        /*
         * A commits first. B's stale conditional write conflicts, then the
         * production retry reads A and persists the merged [A, B] snapshot.
         */
        if (containsB && !containsA) {
          await state.firstWriteCommitted;
        }

        if (options.ifMatch !== undefined && options.ifMatch !== currentEtag()) {
          throw new BlobPreconditionFailedError();
        }

        if (options.allowOverwrite === false && state.fakeStore !== '[]') {
          throw new BlobPreconditionFailedError();
        }

        state.fakeStore = JSON.stringify(nextRegistry);
        state.committedWrites.push(slabs);
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

const { POST } = await import('@/app/api/playground/keeper-register/route');

const { GET: getRegisteredMarkets } = await import('@/app/api/playground/registered-markets/route');

function buildKeeperRegisterRequest(slabAddress: string, suffix: string): NextRequest {
  return new NextRequest('http://localhost/api/playground/keeper-register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-secret': state.adminSecret,
    },
    body: JSON.stringify({
      slabAddress,
      dexPoolAddress: suffix === 'a' ? state.poolA : state.poolB,
      dexType: 'raydium-clmm',
      symbol: `RACE-${suffix.toUpperCase()}`,
      label: `Route race market ${suffix}`,
      deployer: state.deployer,
    }),
  });
}

function extractMarkets(payload: unknown): Array<{ slabAddress?: string }> {
  if (Array.isArray(payload)) {
    return payload as Array<{
      slabAddress?: string;
    }>;
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;

    for (const key of ['markets', 'registeredMarkets', 'data']) {
      if (Array.isArray(record[key])) {
        return record[key] as Array<{
          slabAddress?: string;
        }>;
      }
    }
  }

  throw new Error('Registered-markets discovery response did not contain a market array');
}

beforeEach(() => {
  vi.clearAllMocks();

  state.fakeStore = '[]';
  state.fakeEtagVersion = 0;
  state.registrationReads = 0;
  state.readSnapshots.length = 0;
  state.committedWrites.length = 0;

  state.allRegistrationReadsArrived = new Promise<void>((resolve) => {
    state.releaseRegistrationReads = resolve;
  });

  state.firstWriteCommitted = new Promise<void>((resolve) => {
    state.releaseFirstWrite = resolve;
  });

  globalThis.fetch = vi.fn(async () => {
    const capturedSnapshot = state.fakeStore;
    const capturedEtag = `etag-${state.fakeEtagVersion}`;

    /*
     * The first two reads belong to the two concurrent POST requests.
     * Capture their snapshot+ETag pairs before releasing either request.
     */
    if (state.registrationReads < 2) {
      state.registrationReads += 1;
      state.readSnapshots.push(capturedSnapshot);

      if (state.registrationReads === 2) {
        state.releaseRegistrationReads();
      }

      await Promise.race([
        state.allRegistrationReadsArrived,
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Registration read barrier timed out: ${state.registrationReads}/2 POST requests reached the registry read`,
              ),
            );
          }, 2_000);
        }),
      ]);
    }

    return new Response(capturedSnapshot, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: capturedEtag,
      },
    });
  }) as typeof fetch;
});

afterAll(() => {
  if (originalEnv.NEXT_PUBLIC_DEFAULT_NETWORK === undefined) {
    delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
  } else {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalEnv.NEXT_PUBLIC_DEFAULT_NETWORK;
  }

  if (originalEnv.NEXT_PUBLIC_SOLANA_NETWORK === undefined) {
    delete process.env.NEXT_PUBLIC_SOLANA_NETWORK;
  } else {
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = originalEnv.NEXT_PUBLIC_SOLANA_NETWORK;
  }

  if (originalEnv.ADMIN_API_SECRET === undefined) {
    delete process.env.ADMIN_API_SECRET;
  } else {
    process.env.ADMIN_API_SECRET = originalEnv.ADMIN_API_SECRET;
  }

  if (originalEnv.MAINNET_RPC_URL === undefined) {
    delete process.env.MAINNET_RPC_URL;
  } else {
    process.env.MAINNET_RPC_URL = originalEnv.MAINNET_RPC_URL;
  }
});

describe('POST /api/playground/keeper-register concurrency safety', () => {
  it('preserves both successfully registered markets in discovery', async () => {
    const requestA = buildKeeperRegisterRequest(state.slabA, 'a');

    const requestB = buildKeeperRegisterRequest(state.slabB, 'b');

    const [responseA, responseB] = await Promise.all([POST(requestA), POST(requestB)]);

    const [bodyA, bodyB] = await Promise.all([responseA.json(), responseB.json()]);

    console.info(
      '[keeper-register route response preflight]',
      JSON.stringify(
        {
          responseA: {
            status: responseA.status,
            body: bodyA,
          },
          responseB: {
            status: responseB.status,
            body: bodyB,
          },
          registrationReads: state.registrationReads,
        },
        null,
        2,
      ),
    );

    /*
     * Discovery must only run after both production POST handlers
     * have completed successfully. Otherwise discovery itself could
     * enter the registry-read barrier and obscure the real failure.
     */
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    expect(bodyA).toMatchObject({
      ok: true,
      registered: true,
      slabAddress: state.slabA,
    });

    expect(bodyB).toMatchObject({
      ok: true,
      registered: true,
      slabAddress: state.slabB,
    });

    /*
     * Invoke the real registered-markets discovery route after
     * both keeper-register requests have reported success.
     */
    const discoveryResponse = await Reflect.apply(getRegisteredMarkets, undefined, []);

    const discoveryPayload = await discoveryResponse.json();

    const discoveredMarkets = extractMarkets(discoveryPayload);

    const discoveredSlabs = discoveredMarkets
      .map((market) => market.slabAddress)
      .filter((slab): slab is string => typeof slab === 'string')
      .sort();

    console.info(
      '[keeper-register route concurrency PoC]',
      JSON.stringify(
        {
          responses: [
            {
              status: responseA.status,
              body: bodyA,
            },
            {
              status: responseB.status,
              body: bodyB,
            },
          ],
          registrationReads: state.registrationReads,
          readSnapshots: state.readSnapshots.map((snapshot) => JSON.parse(snapshot)),
          committedWrites: state.committedWrites,
          discoveredSlabs,
        },
        null,
        2,
      ),
    );

    /*
     * Both authenticated route calls report successful
     * registration.
     */
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);

    expect(bodyA).toMatchObject({
      ok: true,
      registered: true,
      slabAddress: state.slabA,
    });

    expect(bodyB).toMatchObject({
      ok: true,
      registered: true,
      slabAddress: state.slabB,
    });

    /*
     * Safety invariant expected to FAIL on the vulnerable
     * read-modify-write implementation.
     */
    expect(discoveredSlabs).toEqual([state.slabA, state.slabB]);
  });
});
