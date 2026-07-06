/**
 * Process-local nonce store for the playground challenge/auth flow.
 *
 * Replaces the Supabase market_challenges table for local dev where
 * no Supabase is configured. Module-level singleton — survives hot
 * reload within the same Node.js process.
 *
 * Exported and shared between:
 *  - app/api/markets/challenge/route.ts  (creates nonces)
 *  - app/api/markets/route.ts            (claims nonces on POST)
 */
import * as crypto from "crypto";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_PER_DEPLOYER = 10;

interface NonceEntry {
  deployer: string;
  expiresAt: number;
}

// Module-level Map — one instance per Node.js process.
const store = new Map<string, NonceEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [nonce, entry] of store) {
    if (entry.expiresAt < now) store.delete(nonce);
  }
}

/** Issue a new nonce for the given deployer. Returns the nonce + expiry, or an error. */
export function createPlaygroundChallenge(
  deployer: string,
): { nonce: string; expiresAt: Date } | { error: string; status: number } {
  pruneExpired();

  // Per-deployer pending cap
  const pending = [...store.values()].filter((v) => v.deployer === deployer).length;
  if (pending >= MAX_PENDING_PER_DEPLOYER) {
    return {
      error: `Too many pending challenges for this deployer. Wait for existing challenges to expire (TTL: 5 min).`,
      status: 429,
    };
  }

  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  store.set(nonce, { deployer, expiresAt: expiresAt.getTime() });
  return { nonce, expiresAt };
}

/**
 * Atomically claim a nonce. Returns true if the nonce was valid and
 * successfully consumed (deleted). Returns false if invalid/expired/wrong deployer.
 */
export function claimPlaygroundChallenge(nonce: string, deployer: string): boolean {
  pruneExpired();
  const entry = store.get(nonce);
  if (!entry) return false;
  if (entry.deployer !== deployer) return false;
  if (entry.expiresAt < Date.now()) {
    store.delete(nonce);
    return false;
  }
  store.delete(nonce);
  return true;
}
