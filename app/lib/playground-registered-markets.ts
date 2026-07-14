/**
 * Playground registered-markets store (Vercel Blob backed).
 *
 * The oracle keeper (dcccrypto/percolator-oracle-keeper feat/cross-cluster-keeper)
 * runs on a NAT'd Mac mini and can only make OUTBOUND calls — it can never be POSTed
 * to directly by this (stateless, serverless) Vercel app. So the flow is inverted:
 *
 *   1. POST /api/playground/keeper-register upserts the newly-created market into a
 *      single JSON blob at a fixed pathname (this module).
 *   2. GET /api/playground/registered-markets reads that same blob back out.
 *   3. The keeper polls (2) outbound on its own interval and adds any market it
 *      doesn't already know about to its local registry.json (see
 *      percolator-oracle-keeper/src/cross-cluster/register-poll.ts).
 *
 * v17 has no on-chain feed_id, so the market↔pool binding lives only in this blob —
 * it's the only place that carries `poolAddress`/`dexType` alongside the devnet
 * `marketAddress`.
 */
import { BlobPreconditionFailedError, get, list, put } from '@vercel/blob';

/** Fixed, non-random-suffixed pathname — there is exactly one blob for this store. */
export const REGISTERED_MARKETS_BLOB_PATHNAME = 'playground/registered-markets.json';

/**
 * H1 hardening: cap the registry so an unbounded stream of registrations (the
 * route was previously unauthenticated) can't grow this blob without limit —
 * every entry is read back on every /api/markets and /api/playground/registered-markets
 * request. Oldest-by-registeredAt entries are evicted first (see upsertRegisteredMarket).
 */
export const MAX_REGISTERED_MARKETS = 100;

export interface RegisteredMarket {
  /** Devnet slab (market) account address. */
  slabAddress: string;
  /** Same value as slabAddress — kept as a separate field to match the keeper's MarketEntry.marketAddress naming. */
  marketAddress: string;
  /** Mainnet DEX pool address the keeper reads its price from. */
  poolAddress: string;
  dexType: string;
  symbol: string | null;
  label: string;
  /** Mainnet token contract address, for keeper-side labelling only. */
  mainnetCA: string | null;
  /** Devnet collateral mint — sim-USDC, the same collateral used by every playground market. */
  collateral: string;
  /** Unix ms when this market was registered. */
  registeredAt: number;
}

function isRegisteredMarket(value: unknown): value is RegisteredMarket {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slabAddress === 'string' &&
    typeof v.marketAddress === 'string' &&
    typeof v.poolAddress === 'string' &&
    typeof v.dexType === 'string' &&
    typeof v.label === 'string' &&
    typeof v.collateral === 'string' &&
    typeof v.registeredAt === 'number'
  );
}

/**
 * J: internal read result that DISTINGUISHES a genuine empty/not-found blob
 * (`ok: true`, nothing to protect — safe to write straight over) from a
 * transient read FAILURE (`ok: false` — network/CDN hiccup, non-OK response,
 * malformed JSON). This distinction is the whole point: `readRegisteredMarkets`
 * (the public, lenient API used by GET routes) collapses both cases to `[]`
 * on purpose, but `upsertRegisteredMarket`'s read-modify-write MUST NOT — see
 * its own doc comment below.
 */
interface RegisteredMarketsReadResult {
  markets: RegisteredMarket[];
  /** False only for a genuine read/parse FAILURE — never for a legitimate
   *  not-yet-created blob (that's `ok: true, markets: []`). */
  ok: boolean;
}

interface RegisteredMarketsMutationReadResult {
  markets: RegisteredMarket[];
  /**
   * ETag belonging to the exact content returned in `markets`.
   * Null means that the registry blob has not been created yet.
   */
  etag: string | null;
  ok: boolean;
}

interface RegisteredMarketsWriteOptions {
  /**
   * Existing-blob optimistic concurrency token.
   * Blob requires overwrite mode whenever `ifMatch` is supplied.
   */
  ifMatch?: string;

  /**
   * False on the initial-create path so another concurrent creator
   * cannot be overwritten.
   */
  allowOverwrite?: boolean;
}

const REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS = 5;

/**
 * Read registry content and its ETag from the same Blob response.
 *
 * Mutation reads bypass the CDN so retries always merge against the
 * latest origin version.
 */
async function readRegisteredMarketsForMutation(): Promise<RegisteredMarketsMutationReadResult> {
  try {
    const result = await get(REGISTERED_MARKETS_BLOB_PATHNAME, {
      access: 'public',
      useCache: false,
    });

    if (result === null) {
      return {
        markets: [],
        etag: null,
        ok: true,
      };
    }

    if (result.statusCode !== 200 || result.stream === null) {
      console.error('[playground-registered-markets] unexpected Blob GET response');

      return {
        markets: [],
        etag: null,
        ok: false,
      };
    }

    const data: unknown = await new Response(result.stream).json();

    if (!Array.isArray(data)) {
      console.error(
        '[playground-registered-markets] blob content is not an array — mutation read failed',
      );

      return {
        markets: [],
        etag: null,
        ok: false,
      };
    }

    return {
      markets: data.filter(isRegisteredMarket),
      etag: result.blob.etag,
      ok: true,
    };
  } catch (err) {
    console.error(
      '[playground-registered-markets] mutation read failed:',
      err instanceof Error ? err.message : String(err),
    );

    return {
      markets: [],
      etag: null,
      ok: false,
    };
  }
}

async function readRegisteredMarketsInternal(): Promise<RegisteredMarketsReadResult> {
  try {
    const { blobs } = await list({
      prefix: REGISTERED_MARKETS_BLOB_PATHNAME,
      limit: 1,
    });
    const found = blobs.find((b) => b.pathname === REGISTERED_MARKETS_BLOB_PATHNAME);
    // Genuinely nothing registered yet — a real empty state, not a failure.
    if (!found) return { markets: [], ok: true };

    // Cache-bust: the public blob is served via a CDN that caches by pathname, so a
    // plain fetch (even `no-store`) can return a stale copy — which would silently
    // drop registrations in the read-modify-write upsert and hide markets from the
    // keeper. A unique query forces a fresh origin read every time.
    const resp = await fetch(`${found.url}?ts=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) {
      console.warn(`[playground-registered-markets] blob fetch ${resp.status} — read failed`);
      return { markets: [], ok: false };
    }
    const data: unknown = await resp.json();
    // A found-but-non-array blob is corrupted data, not "empty" — treat as a
    // failure so an upsert can't silently overwrite it with a partial list.
    if (!Array.isArray(data)) {
      console.warn('[playground-registered-markets] blob content is not an array — read failed');
      return { markets: [], ok: false };
    }
    return { markets: data.filter(isRegisteredMarket), ok: true };
  } catch (err) {
    console.warn(
      '[playground-registered-markets] read failed:',
      err instanceof Error ? err.message : String(err),
    );
    return { markets: [], ok: false };
  }
}

/**
 * Read the current registered-markets blob.
 * Returns an empty array if the blob does not exist yet, or on any read/parse error
 * (never throws — callers treat "empty" and "not-yet-created" identically).
 *
 * This lenient contract is correct for GET-route callers (/api/markets,
 * /api/playground/registered-markets, /api/stake/pools) — a transient read
 * failure there should degrade to "show the curated markets only", not 500
 * the whole route. It is deliberately NOT safe for a read-modify-write
 * (see `upsertRegisteredMarket`, which uses the stricter
 * `readRegisteredMarketsInternal` instead).
 */
export async function readRegisteredMarkets(): Promise<RegisteredMarket[]> {
  const { markets } = await readRegisteredMarketsInternal();
  return markets;
}

/**
 * Persist a complete registry snapshot.
 *
 * Existing snapshots may be guarded by `ifMatch`. Initial creation may
 * disable overwrite so a concurrent creator cannot be silently replaced.
 */
export async function writeRegisteredMarkets(
  markets: RegisteredMarket[],
  options: RegisteredMarketsWriteOptions = {},
): Promise<void> {
  const ifMatch = options.ifMatch;

  await put(REGISTERED_MARKETS_BLOB_PATHNAME, JSON.stringify(markets), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',

    allowOverwrite: ifMatch !== undefined ? true : (options.allowOverwrite ?? true),

    ...(ifMatch !== undefined ? { ifMatch } : {}),

    cacheControlMaxAge: 0,
  });
}

/**
 * Apply deduplication, insertion and registry-cap eviction without
 * mutating the snapshot that was read.
 */
function applyRegisteredMarketUpsert(
  current: RegisteredMarket[],
  entry: RegisteredMarket,
): RegisteredMarket[] {
  const next = [...current];

  const index = next.findIndex((market) => market.slabAddress === entry.slabAddress);

  if (index >= 0) {
    next[index] = entry;
  } else {
    next.push(entry);
  }

  if (next.length <= MAX_REGISTERED_MARKETS) {
    return next;
  }

  const overflow = next.length - MAX_REGISTERED_MARKETS;

  const evictSlabs = new Set(
    [...next]
      .sort((left, right) => left.registeredAt - right.registeredAt)
      .slice(0, overflow)
      .map((market) => market.slabAddress),
  );

  return next.filter((market) => !evictSlabs.has(market.slabAddress));
}

/**
 * Upsert a registered market using Blob optimistic concurrency.
 *
 * A stale ETag causes the operation to read the newest registry,
 * recompute the merge and retry. A failed initial create is retried only
 * when a follow-up read confirms another request created the blob.
 */
export async function upsertRegisteredMarket(entry: RegisteredMarket): Promise<RegisteredMarket[]> {
  let lastConflict: unknown;

  for (let attempt = 1; attempt <= REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await readRegisteredMarketsForMutation();

    if (!snapshot.ok) {
      throw new Error(
        'Failed to read the registered-markets blob before upsert — ' +
          'aborting without writing to avoid overwriting existing ' +
          'registrations with a partial list. Retry the registration.',
      );
    }

    const next = applyRegisteredMarketUpsert(snapshot.markets, entry);

    try {
      if (snapshot.etag === null) {
        await writeRegisteredMarkets(next, {
          allowOverwrite: false,
        });
      } else {
        await writeRegisteredMarkets(next, {
          ifMatch: snapshot.etag,
        });
      }

      return next;
    } catch (err) {
      if (snapshot.etag !== null) {
        if (err instanceof BlobPreconditionFailedError) {
          lastConflict = err;
          continue;
        }

        throw err;
      }

      /*
       * Blob SDK 2.6.1 does not expose a dedicated already-exists
       * exception. Confirm an initial-create race by reading again.
       */
      const afterCreateFailure = await readRegisteredMarketsForMutation();

      if (afterCreateFailure.ok && afterCreateFailure.etag !== null) {
        lastConflict = err;
        continue;
      }

      throw err;
    }
  }

  const conflictDetail =
    lastConflict instanceof Error ? ` Last conflict: ${lastConflict.message}` : '';

  throw new Error(
    `Failed to update the registered-markets blob after ${REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS} optimistic-concurrency attempts.${conflictDetail}`,
  );
}
