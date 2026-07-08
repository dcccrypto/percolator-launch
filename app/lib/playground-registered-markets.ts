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
import { list, put } from "@vercel/blob";

/** Fixed, non-random-suffixed pathname — there is exactly one blob for this store. */
export const REGISTERED_MARKETS_BLOB_PATHNAME = "playground/registered-markets.json";

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
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slabAddress === "string" &&
    typeof v.marketAddress === "string" &&
    typeof v.poolAddress === "string" &&
    typeof v.dexType === "string" &&
    typeof v.label === "string" &&
    typeof v.collateral === "string" &&
    typeof v.registeredAt === "number"
  );
}

/**
 * Read the current registered-markets blob.
 * Returns an empty array if the blob does not exist yet, or on any read/parse error
 * (never throws — callers treat "empty" and "not-yet-created" identically).
 */
export async function readRegisteredMarkets(): Promise<RegisteredMarket[]> {
  try {
    const { blobs } = await list({
      prefix: REGISTERED_MARKETS_BLOB_PATHNAME,
      limit: 1,
    });
    const found = blobs.find((b) => b.pathname === REGISTERED_MARKETS_BLOB_PATHNAME);
    if (!found) return [];

    // Cache-bust: the public blob is served via a CDN that caches by pathname, so a
    // plain fetch (even `no-store`) can return a stale copy — which would silently
    // drop registrations in the read-modify-write upsert and hide markets from the
    // keeper. A unique query forces a fresh origin read every time.
    const resp = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) {
      console.warn(
        `[playground-registered-markets] blob fetch ${resp.status} — treating as empty`,
      );
      return [];
    }
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isRegisteredMarket);
  } catch (err) {
    console.warn(
      "[playground-registered-markets] read failed, treating as empty:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Overwrite the registered-markets blob with `markets`.
 * Throws on failure — callers are expected to catch and return a clear 502.
 */
export async function writeRegisteredMarkets(
  markets: RegisteredMarket[],
): Promise<void> {
  await put(REGISTERED_MARKETS_BLOB_PATHNAME, JSON.stringify(markets), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    // Fixed pathname + upsert semantics: every registration overwrites the single
    // registry blob. Without this, only the first-ever registration succeeds and
    // every subsequent one 502s ("blob already exists").
    allowOverwrite: true,
    // This blob mutates on every registration — don't let the CDN serve a stale copy.
    cacheControlMaxAge: 0,
  });
}

/**
 * Upsert a single market by `slabAddress` (dedup — replace if present, else append)
 * and persist the result. Caps the registry at MAX_REGISTERED_MARKETS, evicting the
 * oldest entries (by `registeredAt`) first when a fresh registration would exceed it
 * — re-registering an existing slab refreshes its `registeredAt` (see the route),
 * which keeps actively-used markets from aging out ahead of stale ones. Returns the
 * updated array.
 */
export async function upsertRegisteredMarket(
  entry: RegisteredMarket,
): Promise<RegisteredMarket[]> {
  const existing = await readRegisteredMarkets();
  const idx = existing.findIndex((m) => m.slabAddress === entry.slabAddress);
  if (idx >= 0) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }

  let capped = existing;
  if (capped.length > MAX_REGISTERED_MARKETS) {
    const overflow = capped.length - MAX_REGISTERED_MARKETS;
    const evictSlabs = new Set(
      [...capped]
        .sort((a, b) => a.registeredAt - b.registeredAt)
        .slice(0, overflow)
        .map((m) => m.slabAddress),
    );
    capped = capped.filter((m) => !evictSlabs.has(m.slabAddress));
  }

  await writeRegisteredMarkets(capped);
  return capped;
}
