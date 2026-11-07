/**
 * The ONE Sim-USDC faucet limit: one claim per wallet per day, whichever surface mints it.
 *
 * Council 2026-11-06-go1106-ux (First-timer, Clerk): the Fund-your-account modal mints through /api/faucet
 * (faucet_claims slot "usdc", 24h) and the /faucet page through /api/playground/faucet, which had its own
 * "playground-faucet" slot with a 1h window. One wallet claimed in the modal and again on /faucet 58 s later
 * (txs 2tzysWCo / 3MadPBz8), while the modal promised "1 claim per wallet per day". Both routes now reserve this
 * slot, with this window, and share this in-memory fallback, so the promise holds.
 */

/** faucet_claims.fund_type for a Sim-USDC mint (the slot /api/faucet type=usdc has always used). */
export const SIM_USDC_CLAIM_FUND_TYPE = "usdc";

/** One claim per wallet per day. */
export const SIM_USDC_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What a refused claim says, on every surface. */
export const SIM_USDC_ALREADY_CLAIMED = "You've already claimed today: the faucet gives once per wallet per day.";

/** The limit as shown in the UI. */
export const SIM_USDC_LIMIT_LABEL = "1 claim per wallet per day";

/**
 * Process-local fallback for when Supabase is unavailable (a cold start resets it; acceptable on devnet). Kept on
 * globalThis so both routes see the same map even when the bundler gives each route its own copy of this module.
 */
const STORE_KEY = "__percolatorSimUsdcClaims__";
function store(): Map<string, number> {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  return (g[STORE_KEY] ??= new Map<string, number>());
}

/** The in-memory fallback's answer for `wallet` at `now`. */
export function simUsdcClaimInMemory(wallet: string, now: number = Date.now()): { limited: boolean; nextClaimAt: string | null } {
  const last = store().get(wallet);
  if (last === undefined || now - last >= SIM_USDC_CLAIM_WINDOW_MS) return { limited: false, nextClaimAt: null };
  return { limited: true, nextClaimAt: new Date(last + SIM_USDC_CLAIM_WINDOW_MS).toISOString() };
}

/** Record a retained claim in the fallback; returns the next claim time. */
export function recordSimUsdcClaimInMemory(wallet: string, now: number = Date.now()): string {
  store().set(wallet, now);
  return new Date(now + SIM_USDC_CLAIM_WINDOW_MS).toISOString();
}

/** The next claim time for a claim made now (what a success response reports). */
export function nextSimUsdcClaimAt(now: number = Date.now()): string {
  return new Date(now + SIM_USDC_CLAIM_WINDOW_MS).toISOString();
}
