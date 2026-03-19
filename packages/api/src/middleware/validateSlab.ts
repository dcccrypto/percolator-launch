import { PublicKey } from "@solana/web3.js";
import type { Context, Next } from "hono";
import { sanitizeSlabAddress } from "@percolator/shared";

/**
 * Known-bad slab addresses that cause backend 500 errors (empty vault / phantom OI).
 *
 * These are the same addresses hardcoded in the Next.js app's BLOCKED_SLAB_ADDRESSES
 * (app/lib/blocklist.ts). They are repeated here so the backend API returns 404
 * even when called directly (bypassing the Next.js proxy layer).
 *
 * GH#1357 / PR#1377 / Sentry follow-up (devops 2026-03-17).
 * Extend via BLOCKED_MARKET_ADDRESSES env var (comma-separated pubkeys).
 */
const HARDCODED_BLOCKED_SLABS: ReadonlySet<string> = new Set([
  // Synced with app/lib/blocklist.ts — keep both in sync (GH#1461/1462).
  "BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP", // Stale SOL/USD slab (PR #1179)
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT", // GH#837: wrong oracle_authority
  "H5Vunzd2yAMygnpFiGUASDSx2s8P3bfPTzjCfrRsPeph", // GH#1218: NL/USD corrupt OI
  "3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD", // SEX/USD — empty vault (PR #1377)
  "3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ", // Empty-vault phantom-OI (PR #1377)
  "3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn", // Empty-vault phantom-OI (PR #1377)
  "CRJH9Gtk7qQDdjzDufnAZdfa7AHisfvxCmVVvzpzQN9v", // GH#1398: garbage test market
  // GH#1398 follow-up: phantom slabs with oracle_authority = system program
  "J6UU4VHbYXpCAACr5o5xjUVmquagiP2NGbbMp68VUCX9",
  "8L47yqvQRLxZ6PzW3b9jawEM79CmokBvUzeLR7mvtyuU",
  "8kkED3uZznGzSidr8kYJPd3VhzSh7LVngNUx2V1qnW9L",
  "8pKtAV3z6iTKekieF9EenQ4tk1rkAVa9oYsqe7h1PGjx",
  "Eekuz2TgXRPq3rsp5brRW5hofxLdwt6KUXbLUQCKHK9G",
  "Av3zVrW5deLpLo1qZZ7yNJ5Lq5ja4Z9ixijVhV4MuRzE",
  "CrbDmfiooBUTFfGyMhJ1hpToCrBLAXXKySBwEnLHV6kj",
  "FhpPmmuh5UDAjvEjrYBPFwmj4CP4otvsYMxtTb46p1Ss",
  "7xozYEbKhEdjQn5pCAV8bUDQGugZttqZTduPeHkoqRb8",
  "3dp3e288oPjs5w92fg26cVYQMHGuUpsj8YbSFn6wrzp4",
  "8nzjXMvdkC4fRF491QkpKE6aFTLmEcpXEnbh4wQT4iUA",
  "3bmCyPeeDwAfLbhfnRpYJHkWVqAf3Q5JaWXGfZjbmjNp", // GH#1410: phantom SEX/USD
  "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c", // GH#1413: DfLoAzny/USD phantom
]);

/**
 * Runtime-configurable blocklist loaded once at startup from BLOCKED_MARKET_ADDRESSES.
 * Allows ops to block new addresses without a code deploy.
 */
const ENV_BLOCKED_SLABS: ReadonlySet<string> = new Set(
  (process.env.BLOCKED_MARKET_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Returns true if the slab is on the backend blocklist (hardcoded or env-var).
 * Exported so other routes (e.g. /funding/global) can apply the same predicate
 * without going through the Hono middleware (GH#1459).
 */
export function isBlockedSlab(slab: string): boolean {
  return HARDCODED_BLOCKED_SLABS.has(slab) || ENV_BLOCKED_SLABS.has(slab);
}

// Keep internal alias for the middleware below
function isBlocked(slab: string): boolean {
  return isBlockedSlab(slab);
}

/**
 * Hono middleware that validates the `:slab` route param is a valid Solana public key.
 * Returns 400 if invalid, 404 if the address is on the backend blocklist.
 */
export async function validateSlab(c: Context, next: Next) {
  const slab = c.req.param("slab");
  if (!slab) return next();

  // First sanitize the input
  const sanitized = sanitizeSlabAddress(slab);
  if (!sanitized) {
    return c.json({ error: "Invalid slab address" }, 400);
  }

  // Then validate it's a valid Solana public key
  try {
    new PublicKey(sanitized);
  } catch {
    return c.json({ error: "Invalid slab address" }, 400);
  }

  // Blocklist check — return 404 for known-bad/empty slabs instead of proxying
  // to DB queries that return 500 (phantom OI / no market_stats rows).
  if (isBlocked(sanitized)) {
    return c.json({ error: "Market not found" }, 404);
  }

  return next();
}
