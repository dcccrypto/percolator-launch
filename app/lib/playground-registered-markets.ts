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
    const resp = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) {
      console.warn(
        `[playground-registered-markets] blob fetch ${resp.status} — read failed`,
      );
      return { markets: [], ok: false };
    }
    const data: unknown = await resp.json();
    // A found-but-non-array blob is corrupted data, not "empty" — treat as a
    // failure so an upsert can't silently overwrite it with a partial list.
    if (!Array.isArray(data)) {
      console.warn("[playground-registered-markets] blob content is not an array — read failed");
      return { markets: [], ok: false };
    }
    return { markets: data.filter(isRegisteredMarket), ok: true };
  } catch (err) {
    console.warn(
      "[playground-registered-markets] read failed:",
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
 *
 * J: this is a read-modify-write, so it MUST fail closed on a read failure. The
 * previous version called the lenient `readRegisteredMarkets()`, which returns `[]`
 * for BOTH "genuinely nothing registered yet" AND "the read just failed" (network
 * blip, CDN hiccup, malformed JSON) — indistinguishable to this function. On a
 * transient read failure it would proceed anyway, treat the blob as empty, and
 * `writeRegisteredMarkets` a SINGLE-entry array over the top, destroying up to
 * `MAX_REGISTERED_MARKETS` (100) existing market↔pool bindings. Using the stricter
 * `readRegisteredMarketsInternal` (which reports `ok: false` only for a genuine
 * failure, never for a legitimate empty/not-yet-created blob) lets this function
 * throw and abort instead — the caller (keeper-register route) already catches and
 * returns a 502, so this is a safe, visible failure instead of silent data loss.
 */
export async function upsertRegisteredMarket(
  entry: RegisteredMarket,
): Promise<RegisteredMarket[]> {
  const { markets: existing, ok } = await readRegisteredMarketsInternal();
  if (!ok) {
    throw new Error(
      "Failed to read the registered-markets blob before upsert — aborting without writing, " +
      "to avoid overwriting existing registrations with a partial list. Retry the registration.",
    );
  }
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
