/**
 * Durable claim store for the /api/devnet-pre-fund FALLBACK rate limiter —
 * Vercel Blob backed.
 *
 * GH#2335 / PR#2336 follow-up: /api/devnet-pre-fund's PRIMARY rate gate is the
 * Supabase-backed `faucet_claims` INSERT-as-gate (lib/faucet-rate-gate.ts,
 * cross-instance-safe via a UNIQUE(wallet, fund_type) constraint). When Supabase is
 * unavailable, the route falls back to a rate limiter that must NOT itself depend on
 * Supabase. That fallback used to be a module-level `Map` — "process-local, survives
 * hot reload within the same Node.js process." On Vercel that's per-lambda-instance:
 * concurrent requests on different instances each see an empty Map (`limited: false`)
 * and can all mint, even after PR#2336 made the intra-instance check-then-record
 * synchronous. That's the exact bug class already fixed for the nonce store (see
 * playground-nonce-store.ts's H1v1 incident note) and the registered-markets store.
 *
 * Unlike those two stores (one shared JSON array, read-modify-write, "accepted
 * tradeoff" — no true atomicity, fine for short-lived single-use nonces / dedup-by-
 * key upserts), this store needs a real cross-instance compare-and-swap: the whole
 * point is to stop two concurrent requests for the SAME rateKey from both minting.
 * It gets one from Vercel Blob itself: `put(pathname, body, { allowOverwrite: false })`
 * (the default) throws if a blob already exists at that exact pathname — enforced
 * server-side by the Blob store, not a client-side check (this codebase already
 * relies on the inverse of this fact — see the `allowOverwrite: true` comments in
 * playground-nonce-store.ts / playground-registered-markets.ts: "Without this, only
 * the first-ever write succeeds"). So: one blob per rateKey (pathname derived from a
 * hash of the key), and `reserveClaim` wins or loses the create race atomically.
 */
import * as crypto from "node:crypto";
import { del, list, put } from "@vercel/blob";

/** 24h — mirrors RATE_LIMIT_MS in lib/faucet-rate-gate.ts. */
export const PREFUND_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

const CLAIM_BLOB_PREFIX = "playground/prefund-claims/";

interface ClaimEntry {
  /** The route's `rateKey` — `${walletAddress}:devnet-pre-fund:${mintAddress}`. Kept
   *  in the body (not just encoded in the pathname) for debuggability. */
  key: string;
  claimedAt: number;
  expiresAt: number;
}

function isClaimEntry(value: unknown): value is ClaimEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === "string" &&
    typeof v.claimedAt === "number" &&
    typeof v.expiresAt === "number"
  );
}

/** One fixed, deterministic pathname per rateKey — hashed so wallet/mint values
 *  don't need URL-safety handling and every key maps to a bounded-length path. */
function claimPathname(rateKey: string): string {
  const digest = crypto.createHash("sha256").update(rateKey).digest("hex");
  return `${CLAIM_BLOB_PREFIX}${digest}.json`;
}

/** Read the claim blob at `pathname`, if any. Returns null if absent, unreadable, or
 *  malformed — never throws (mirrors readRegisteredMarkets / the nonce store). */
async function readClaimBlob(
  pathname: string,
): Promise<{ url: string; entry: ClaimEntry } | null> {
  try {
    const { blobs } = await list({ prefix: pathname, limit: 1 });
    const found = blobs.find((b) => b.pathname === pathname);
    if (!found) return null;

    // Cache-bust: the public blob is served via a CDN that caches by pathname, so a
    // plain fetch can return a stale copy — see readRegisteredMarkets for the same
    // fix. Stale reads here would let an already-claimed rate-limit window look free.
    const resp = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) return null;
    const data: unknown = await resp.json();
    if (!isClaimEntry(data)) return null;
    return { url: found.url, entry: data };
  } catch (err) {
    console.warn(
      "[prefund-claim-store] read failed, treating as absent:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Read-only check: is there currently an unexpired claim for `rateKey`? Does NOT
 * reserve anything — used for a cheap early-exit 429 before doing any mint-adjacent
 * work (loading the mint authority keypair, on-chain getMint, etc). The authoritative
 * check-and-reserve happens via `reserveClaim` immediately before the mint
 * transaction is built, closing the check-before-record race this store exists to
 * fix (see reserveClaim's doc comment).
 */
export async function peekClaim(
  rateKey: string,
): Promise<{ limited: boolean; nextClaimAt: string | null }> {
  const found = await readClaimBlob(claimPathname(rateKey));
  if (found && found.entry.expiresAt >= Date.now()) {
    return { limited: true, nextClaimAt: new Date(found.entry.expiresAt).toISOString() };
  }
  return { limited: false, nextClaimAt: null };
}

/**
 * Reserve a claim for `rateKey`, cross-instance-atomically. If no unexpired claim
 * exists for `rateKey`, records one (expiring after `ttlMs`) and returns
 * `reserved: true`. If an unexpired claim already exists (recorded by this or any
 * other request/instance), returns `reserved: false` with its expiry.
 *
 * The actual atomicity comes from the final `put()` below: Vercel Blob rejects a
 * write to a pathname that already has a blob unless `allowOverwrite: true` is
 * passed, and that check is enforced by the Blob store itself — so two concurrent
 * `reserveClaim()` calls for the SAME rateKey, even across different Vercel lambda
 * instances, race on ONE write: exactly one wins. Everything before that call
 * (reading + best-effort deleting a stale/expired entry) is just cleanup so a fresh
 * reservation has a clear pathname to create; it doesn't need to be atomic itself,
 * because if two callers both think a slot is free and race to `put()`, only one
 * `put()` actually succeeds.
 *
 * Fails OPEN (reserved: true) if the Blob store is unreachable entirely — this is
 * the fallback-of-a-fallback path (Supabase down AND Blob down), and the spec here
 * is "don't hard-block the faucet," matching the fail-open behavior the old
 * per-lambda in-memory Map had in practice. Logged either way so it's visible.
 */
export async function reserveClaim(
  rateKey: string,
  ttlMs: number = PREFUND_CLAIM_TTL_MS,
): Promise<{ reserved: boolean; nextClaimAt: string | null }> {
  const pathname = claimPathname(rateKey);

  try {
    // Clear a stale (expired) claim first so the atomic create below has a clean
    // slot to write into. Not required for correctness of the "first ever
    // reservation" case (that's protected purely by the put() below) — this only
    // matters for re-claiming a key after its previous claim's TTL has elapsed.
    const existing = await readClaimBlob(pathname);
    if (existing) {
      if (existing.entry.expiresAt >= Date.now()) {
        return { reserved: false, nextClaimAt: new Date(existing.entry.expiresAt).toISOString() };
      }
      try {
        await del(existing.url);
      } catch (err) {
        // Best-effort. If this delete fails and the expired blob lingers, the put()
        // below will throw "already exists" even though the claim is expired — this
        // request will be (incorrectly) denied. That's a fail-CLOSED rough edge
        // (annoying — "try again later" when you shouldn't have to), not a fail-OPEN
        // one, so it's an acceptable tradeoff for a security-motivated rate limiter.
        console.warn(
          "[prefund-claim-store] failed to clear expired claim (may cause a spurious 429 until cleared):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const now = Date.now();
    const entry: ClaimEntry = { key: rateKey, claimedAt: now, expiresAt: now + ttlMs };
    await put(pathname, JSON.stringify(entry), {
      access: "public",
      addRandomSuffix: false,
      contentType: "application/json",
      // Deliberately NOT allowOverwrite: true — see doc comment above. The default
      // (false) is what makes this call a real create-if-absent / compare-and-swap.
      cacheControlMaxAge: 0,
    });
    return { reserved: true, nextClaimAt: null };
  } catch (err) {
    // Either we lost the create race (another request's put() landed first) or the
    // Blob store itself is unavailable. Re-read to tell the two apart: if a claim is
    // now there, report its expiry (denied). If nothing is there, Blob is down —
    // fail open per this module's contract.
    const found = await readClaimBlob(pathname).catch(() => null);
    if (found) {
      return { reserved: false, nextClaimAt: new Date(found.entry.expiresAt).toISOString() };
    }
    console.warn(
      "[prefund-claim-store] reserveClaim failed, failing open (not blocking faucet):",
      err instanceof Error ? err.message : String(err),
    );
    return { reserved: true, nextClaimAt: null };
  }
}

/**
 * Release a previously-reserved claim for `rateKey` (e.g. because the mint that
 * reserved it failed) so the wallet/mint pair isn't locked out for the full TTL.
 * Best-effort: swallows and logs errors rather than throwing, mirroring
 * releaseFaucetClaim in lib/faucet-rate-gate.ts.
 */
export async function releaseClaim(rateKey: string): Promise<void> {
  const pathname = claimPathname(rateKey);
  try {
    const found = await readClaimBlob(pathname);
    if (found) {
      await del(found.url);
    }
  } catch (err) {
    console.warn(
      "[prefund-claim-store] releaseClaim failed (best-effort):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
