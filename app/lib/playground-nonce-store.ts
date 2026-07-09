/**
 * Nonce store for the playground challenge/auth flow — Vercel Blob backed.
 *
 * Replaces the Supabase market_challenges table for local dev / the playground
 * deployment (no Supabase connection required). Shared between:
 *  - app/api/markets/challenge/route.ts  (creates nonces)
 *  - app/api/markets/route.ts            (claims nonces on POST)
 *
 * H1v1 incident (2026-07-09): this used to be a module-level `Map` — "process-local,
 * survives hot reload within the same Node.js process." On Vercel that's per-lambda-
 * instance: the GET that issues a nonce and the POST that claims it can land on
 * different instances with no shared memory, so a real launch could 400 "missing
 * nonce" or 401 "invalid/expired nonce" essentially at random, even when the client
 * did everything right. (POST /api/playground/keeper-register hit the same class of
 * bug and was fixed separately by dropping the nonce scheme entirely in favor of a
 * stateless signed message — see that route's doc comment. /api/markets keeps the
 * nonce+challenge shape, so this store needed to become durable instead.)
 *
 * Backed by the same Vercel Blob JSON-store pattern already used by
 * lib/playground-registered-markets.ts: one small JSON array at a fixed pathname,
 * read-modify-write on every issue/claim. Nonces are short-lived (5 min TTL),
 * single-use, and only ever known to the deployer that just fetched one, so the
 * lack of a true atomic compare-and-swap is an accepted tradeoff here (mirrors the
 * same tolerance already accepted for the registered-markets blob) — a genuine
 * concurrent double-claim of the SAME nonce by the SAME deployer is not a realistic
 * attack surface, and a lost concurrent write just means "ask for a fresh nonce."
 */
import * as crypto from "node:crypto";
import { list, put } from "@vercel/blob";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_PER_DEPLOYER = 10;

/** Fixed, non-random-suffixed pathname — there is exactly one blob for this store. */
const NONCE_BLOB_PATHNAME = "playground/nonces.json";

/** Hard cap on total pending nonces persisted, regardless of how many distinct
 *  deployers are mid-flow — bounds blob size. Oldest-expiring entries are evicted
 *  first if ever exceeded; well above realistic concurrent playground usage. */
const MAX_TOTAL_PENDING = 500;

interface NonceEntry {
  nonce: string;
  deployer: string;
  expiresAt: number;
}

function isNonceEntry(value: unknown): value is NonceEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === "string" &&
    typeof v.deployer === "string" &&
    typeof v.expiresAt === "number"
  );
}

function pruneExpired(entries: NonceEntry[]): NonceEntry[] {
  const now = Date.now();
  return entries.filter((e) => e.expiresAt >= now);
}

/** Read the current nonce blob. Returns [] if it doesn't exist yet or on any
 *  read/parse error — never throws (mirrors readRegisteredMarkets). */
async function readStore(): Promise<NonceEntry[]> {
  try {
    const { blobs } = await list({ prefix: NONCE_BLOB_PATHNAME, limit: 1 });
    const found = blobs.find((b) => b.pathname === NONCE_BLOB_PATHNAME);
    if (!found) return [];

    // Cache-bust: the public blob is served via a CDN that caches by pathname, so a
    // plain fetch can return a stale copy — see readRegisteredMarkets for the same
    // fix. Stale reads here would let an already-claimed/expired nonce look valid.
    const resp = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return [];
    const data: unknown = await resp.json();
    if (!Array.isArray(data)) return [];
    return data.filter(isNonceEntry);
  } catch (err) {
    console.warn(
      "[playground-nonce-store] read failed, treating as empty:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/** Overwrite the nonce blob with `entries`. Throws on failure — callers already run
 *  inside a route-level try/catch (see app/api/markets/challenge and app/api/markets). */
async function writeStore(entries: NonceEntry[]): Promise<void> {
  await put(NONCE_BLOB_PATHNAME, JSON.stringify(entries), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    // Fixed pathname + upsert semantics — every issue/claim overwrites the single
    // store blob. Without this, only the first-ever write succeeds.
    allowOverwrite: true,
    // Mutates on every issue/claim — don't let the CDN serve a stale copy.
    cacheControlMaxAge: 0,
  });
}

/** Issue a new nonce for the given deployer. Returns the nonce + expiry, or an error. */
export async function createPlaygroundChallenge(
  deployer: string,
): Promise<{ nonce: string; expiresAt: Date } | { error: string; status: number }> {
  const existing = pruneExpired(await readStore());

  // Per-deployer pending cap
  const pending = existing.filter((e) => e.deployer === deployer).length;
  if (pending >= MAX_PENDING_PER_DEPLOYER) {
    return {
      error: `Too many pending challenges for this deployer. Wait for existing challenges to expire (TTL: 5 min).`,
      status: 429,
    };
  }

  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  let next = [...existing, { nonce, deployer, expiresAt: expiresAt.getTime() }];
  if (next.length > MAX_TOTAL_PENDING) {
    const overflow = next.length - MAX_TOTAL_PENDING;
    next = next.sort((a, b) => a.expiresAt - b.expiresAt).slice(overflow);
  }
  await writeStore(next);
  return { nonce, expiresAt };
}

/**
 * Atomically-enough claim a nonce (see file header for the accepted read-modify-write
 * tradeoff). Returns true if the nonce was valid and successfully consumed (deleted).
 * Returns false if invalid/expired/wrong deployer.
 */
export async function claimPlaygroundChallenge(nonce: string, deployer: string): Promise<boolean> {
  const existing = pruneExpired(await readStore());
  const idx = existing.findIndex((e) => e.nonce === nonce);
  if (idx === -1) return false;
  if (existing[idx].deployer !== deployer) return false;

  existing.splice(idx, 1);
  await writeStore(existing);
  return true;
}
