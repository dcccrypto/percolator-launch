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

  /** Blob store by pathname (the registry is versioned snapshots + the legacy seed blob). */
  store: new Map<string, string>(),

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

/*
 * GET /api/playground/registered-markets drops slabs the RPC confirms are gone
 * (GH#2988) via lib/live-market-state, which pulls in the real slab parsers
 * (v17-engine-config → SDK V17_* layout constants) and lib/server-rpc. This
 * test is about the Blob lost-update race, not chain liveness, so every slab
 * is reported as existing: the route's chain filter drops nothing and the race
 * assertions below keep their meaning.
 */
vi.mock('@/lib/live-market-state', () => ({
  readSlabExistence: vi.fn(async () => ({
    missing: new Set<string>(),
    unresolved: new Set<string>(),
  })),
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

      throw new Error('mock mainnet RPC unavailable');
    }

    /*
     * Mainnet pool classification (lib/dex-pool-owner.ts): the pool is a
     * Meteora DLMM pool by OWNER. The route no longer falls back to the client
     * dexType string when mainnet is unreachable (E2E B21), so this test, which
     * is about the concurrency race and not the DEX, supplies a real owner.
     */
    async getMultipleAccountsInfo(keys: PublicKey[]): Promise<unknown[]> {
      return keys.map(() => ({
        owner: { toBase58: () => 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' },
        data: new Uint8Array(0),
      }));
    }
  }

  return {
    Connection,
    PublicKey,
  };
});

vi.mock('@percolatorct/sdk', () => ({
  V17_HEADER_LEN: 16,

  // The quote gate (lib/dex-pool-owner.ts) parses the pool with the SDK; this pool is WSOL-quoted.
  parseDexPool: vi.fn(() => ({
    quoteMint: { toBase58: () => 'So11111111111111111111111111111111111111112' },
  })),

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

/*
 * keeper-register now writes the markets row as well as the blob — that row is
 * the single source of truth the keeper reads. This double records the write so
 * the concurrency test can assert BOTH stores stay consistent, rather than
 * failing on missing Supabase env.
 */
const dbWrites: Array<Record<string, unknown>> = [];
vi.mock('@/lib/supabase', () => ({
  getServerNetwork: () => 'devnet',
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
      insert: async (payload: Record<string, unknown>) => {
        dbWrites.push(payload);
        return { error: null };
      },
      update: (payload: Record<string, unknown>) => {
        dbWrites.push(payload);
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }),
  }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: [...state.store.keys()]
      .filter((pathname) => pathname.startsWith(prefix))
      .map((pathname) => ({ pathname, url: `https://blob.test/${pathname}` })),
    hasMore: false,
  })),

  put: vi.fn(async (pathname: string, body: unknown, options: { allowOverwrite?: boolean } = {}) => {
    const nextRegistry = JSON.parse(String(body)) as Array<{ slabAddress?: string }>;
    const slabs = nextRegistry
      .map((market) => market.slabAddress)
      .filter((slab): slab is string => typeof slab === 'string');
    const containsA = slabs.includes(state.slabA);
    const containsB = slabs.includes(state.slabB);

    /*
     * A commits first. B's create of the SAME snapshot sequence then conflicts (create-only),
     * and the production retry reads A's snapshot and persists the merged [A, B] one.
     */
    if (containsB && !containsA) {
      await state.firstWriteCommitted;
    }

    if (options.allowOverwrite === false && state.store.has(pathname)) {
      throw new Error('Vercel Blob: This blob already exists');
    }

    state.store.set(pathname, JSON.stringify(nextRegistry));
    state.committedWrites.push(slabs);

    if (containsA && !containsB) {
      state.releaseFirstWrite();
    }

    return { url: `https://blob.test/${pathname}`, pathname };
  }),

  del: vi.fn(async (urls: string[]) => {
    for (const url of urls) state.store.delete(url.replace('https://blob.test/', ''));
  }),
}));

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
      dexType: 'meteora-dlmm',
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

  state.store.clear();
  state.store.set('playground/registered-markets.json', '[]');
  state.registrationReads = 0;
  state.readSnapshots.length = 0;
  state.committedWrites.length = 0;

  state.allRegistrationReadsArrived = new Promise<void>((resolve) => {
    state.releaseRegistrationReads = resolve;
  });

  state.firstWriteCommitted = new Promise<void>((resolve) => {
    state.releaseFirstWrite = resolve;
  });

  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const capturedSnapshot = state.store.get(href.replace('https://blob.test/', '').split('?')[0]) ?? '[]';

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
    // Registration must also have written the markets row — that row, not the
    // blob, is what the keeper reads and what lists the market.
    expect(dbWrites.length).toBeGreaterThanOrEqual(2);
    expect(dbWrites.every((w) => w.keeper_status === 'active')).toBe(true);
    expect(dbWrites.every((w) => w.metadata_source === 'manual')).toBe(true);

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
    // Registration must also have written the markets row — that row, not the
    // blob, is what the keeper reads and what lists the market.
    expect(dbWrites.length).toBeGreaterThanOrEqual(2);
    expect(dbWrites.every((w) => w.keeper_status === 'active')).toBe(true);
    expect(dbWrites.every((w) => w.metadata_source === 'manual')).toBe(true);

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
