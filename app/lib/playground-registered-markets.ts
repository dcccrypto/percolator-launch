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
import { del, list, put } from '@vercel/blob';

/**
 * LEGACY single-blob pathname. Read only as the seed when no versioned snapshot exists yet;
 * never written any more (see "Storage" below).
 */
export const REGISTERED_MARKETS_BLOB_PATHNAME = 'playground/registered-markets.json';

/**
 * Storage (2026-10-01). The registry used to be ONE blob overwritten in place, read back with a
 * `?ts=` cache-buster and CAS'd with `ifMatch`. The Blob CDN ignores the query string (measured:
 * `x-vercel-cache: HIT`, `age` past `max-age`, for a fresh `?ts=`), so a function could read a
 * minutes-old copy: the GET feed hid a just-registered market from the keeper, and every CAS
 * attempt carried a stale ETag until the route gave up with 502.
 *
 * Now every write creates a NEW immutable snapshot `playground/registered-markets/v<seq>.json`
 * (create-only, `allowOverwrite: false`). Readers `list()` the prefix (the Blob API, not the CDN)
 * and fetch the highest `seq`: a URL whose content never changes cannot be served stale. The
 * create-only write of `seq + 1` IS the compare-and-swap: of two writers that read `seq`, exactly
 * one creates `seq + 1`; the other re-reads and merges. Old snapshots beyond the newest
 * REGISTERED_MARKETS_KEEP_VERSIONS are deleted best-effort.
 */
export const REGISTERED_MARKETS_VERSION_PREFIX = 'playground/registered-markets/';
export const REGISTERED_MARKETS_KEEP_VERSIONS = 5;
const SEQ_DIGITS = 12;

export function registeredMarketsVersionPath(seq: number): string {
  return `${REGISTERED_MARKETS_VERSION_PREFIX}v${String(seq).padStart(SEQ_DIGITS, '0')}.json`;
}

/** The snapshot sequence encoded in a versioned pathname, or null for anything else. */
export function parseRegisteredMarketsVersion(pathname: string): number | null {
  if (!pathname.startsWith(REGISTERED_MARKETS_VERSION_PREFIX)) return null;
  const m = /^v(\d{1,15})\.json$/.exec(pathname.slice(REGISTERED_MARKETS_VERSION_PREFIX.length));
  return m ? Number(m[1]) : null;
}

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
 * J: the internal read DISTINGUISHES a genuine empty store (`ok: true`, nothing to protect) from
 * a read FAILURE (`ok: false`). `readRegisteredMarkets` (lenient GET-route API) collapses both to
 * `[]` on purpose; `upsertRegisteredMarket`'s read-merge-write MUST NOT write on top of a failed
 * read (it would replace every binding with one entry).
 */
interface RegisteredMarketsSnapshot {
  markets: RegisteredMarket[];
  /** Sequence of the snapshot read (0 = none yet: empty, or seeded from the legacy blob). */
  seq: number;
  ok: boolean;
}

interface VersionRef {
  seq: number;
  url: string;
  pathname: string;
}

const REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS = 6;
const REGISTERED_MARKETS_RETRY_BASE_DELAY_MS = 100;
const REGISTERED_MARKETS_RETRY_MAX_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter between create-only attempts (50-100% of the step). */
function casRetryDelayMs(attempt: number): number {
  const exp = Math.min(REGISTERED_MARKETS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), REGISTERED_MARKETS_RETRY_MAX_DELAY_MS);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/** Every versioned snapshot, newest first (the Blob list API: authoritative, not the CDN). */
async function listVersions(): Promise<VersionRef[]> {
  const out: VersionRef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const res = await list({ prefix: REGISTERED_MARKETS_VERSION_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const b of res.blobs) {
      const seq = parseRegisteredMarketsVersion(b.pathname);
      if (seq !== null) out.push({ seq, url: b.url, pathname: b.pathname });
    }
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return out.sort((a, b) => b.seq - a.seq);
}

async function fetchMarkets(url: string): Promise<RegisteredMarket[] | null> {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) {
    console.warn(`[playground-registered-markets] blob fetch ${resp.status} — read failed`);
    return null;
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    console.warn('[playground-registered-markets] blob content is not JSON — read failed');
    return null;
  }
  // A found-but-non-array blob is corrupted data, not "empty".
  if (!Array.isArray(data)) {
    console.warn('[playground-registered-markets] blob content is not an array — read failed');
    return null;
  }
  return data.filter(isRegisteredMarket);
}

/**
 * The newest snapshot. With no versioned snapshot yet, the legacy single blob seeds the registry
 * (seq 0); the first write then creates v1 from it.
 */
async function readSnapshot(): Promise<RegisteredMarketsSnapshot> {
  try {
    const versions = await listVersions();
    if (versions.length > 0) {
      const markets = await fetchMarkets(versions[0].url);
      if (markets !== null) return { markets, seq: versions[0].seq, ok: true };
      // The newest snapshot can't be read this moment: serve the previous one to readers, but
      // report it as not-ok so a writer never merges onto an older seq (fail closed).
      const prev = versions[1] ? await fetchMarkets(versions[1].url) : null;
      return { markets: prev ?? [], seq: 0, ok: false };
    }
    const { blobs } = await list({ prefix: REGISTERED_MARKETS_BLOB_PATHNAME, limit: 1 });
    const legacy = blobs.find((b) => b.pathname === REGISTERED_MARKETS_BLOB_PATHNAME);
    if (!legacy) return { markets: [], seq: 0, ok: true };
    const markets = await fetchMarkets(legacy.url);
    return markets === null ? { markets: [], seq: 0, ok: false } : { markets, seq: 0, ok: true };
  } catch (err) {
    console.warn('[playground-registered-markets] read failed:', err instanceof Error ? err.message : String(err));
    return { markets: [], seq: 0, ok: false };
  }
}

/**
 * Read the current registered markets.
 * Returns an empty array if nothing is registered yet, or on any read/parse error
 * (never throws — callers treat "empty" and "not-yet-created" identically).
 *
 * This lenient contract is correct for GET-route callers (/api/markets,
 * /api/playground/registered-markets, /api/stake/pools) — a transient read
 * failure there should degrade to "show the curated markets only", not 500
 * the whole route. It is deliberately NOT safe for a read-modify-write
 * (see `upsertRegisteredMarket`, which aborts on a failed read).
 */
export async function readRegisteredMarkets(): Promise<RegisteredMarket[]> {
  // Lenient: on a failed newest read this is the previous snapshot (or []), never a throw.
  const { markets } = await readSnapshot();
  return markets;
}

/**
 * The lenient read plus whether it was a real read: `ok: false` when the newest snapshot couldn't
 * be read (the markets are then the previous snapshot, or none). For callers that must not present
 * a partial list as complete; never throws.
 */
export async function readRegisteredMarketsChecked(): Promise<{ markets: RegisteredMarket[]; ok: boolean }> {
  // No store configured (local dev, a preview without the token): nothing is registered, which is a
  // complete answer, not a failed read. Without this every request would read as failed.
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { markets: [], ok: true };
  const { markets, ok } = await readSnapshot();
  return { markets, ok };
}

/** Create snapshot `seq` (create-only: throws if it already exists). */
async function createSnapshot(seq: number, markets: RegisteredMarket[]): Promise<void> {
  await put(registeredMarketsVersionPath(seq), JSON.stringify(markets), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    // Never overwrite: this is the compare-and-swap (see "Storage").
    allowOverwrite: false,
  });
}

/** Delete snapshots older than the newest KEEP. Best-effort: never fails a registration. */
async function pruneOldSnapshots(): Promise<void> {
  try {
    const stale = (await listVersions()).slice(REGISTERED_MARKETS_KEEP_VERSIONS).map((v) => v.url);
    if (stale.length > 0) await del(stale);
  } catch (err) {
    console.warn('[playground-registered-markets] prune skipped:', err instanceof Error ? err.message : String(err));
  }
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
 * Upsert a registered market: read the newest snapshot, merge, create snapshot `seq + 1`.
 * Losing the create race (another writer created `seq + 1` first) re-reads and re-merges, so
 * concurrent registrations never drop each other. A failed read aborts without writing.
 */
export async function upsertRegisteredMarket(entry: RegisteredMarket): Promise<RegisteredMarket[]> {
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await readSnapshot();
    if (!snapshot.ok) {
      throw new Error(
        'Failed to read the registered-markets blob before upsert — ' +
          'aborting without writing to avoid overwriting existing ' +
          'registrations with a partial list. Retry the registration.',
      );
    }
    const next = applyRegisteredMarketUpsert(snapshot.markets, entry);
    try {
      await createSnapshot(snapshot.seq + 1, next);
    } catch (err) {
      // Lost the race only if someone else's seq+1 now exists; anything else is a real failure.
      const newest = await listVersions().then((v) => v[0]?.seq ?? 0, () => 0);
      if (newest >= snapshot.seq + 1) {
        lastConflict = err;
        await sleep(casRetryDelayMs(attempt));
        continue;
      }
      throw err;
    }
    // Verify-after-create: a writer that stalled while several others wrote can find its target
    // seq already PRUNED, so the create-only write "succeeds" on a recycled path below the
    // newest snapshot and its entry would be silently lost. Only a write that is the newest
    // snapshot counts; otherwise re-read the true newest and merge again.
    const newestAfter = await listVersions().then((v) => v[0]?.seq ?? null, () => null);
    if (newestAfter !== null && newestAfter !== snapshot.seq + 1) {
      lastConflict = new Error(`snapshot v${snapshot.seq + 1} was superseded by v${newestAfter} while writing`);
      await sleep(casRetryDelayMs(attempt));
      continue;
    }
    await pruneOldSnapshots();
    return next;
  }
  const conflictDetail = lastConflict instanceof Error ? ` Last conflict: ${lastConflict.message}` : '';
  throw new Error(
    `Failed to update the registered-markets blob after ${REGISTERED_MARKETS_WRITE_MAX_ATTEMPTS} attempts.${conflictDetail}`,
  );
}
