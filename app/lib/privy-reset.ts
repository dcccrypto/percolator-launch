/**
 * User-click-only "Reset wallet connection": the in-app equivalent of "Clear site data" for the
 * signed-out Connect loop (GH#2862 sibling). The main cause of that loop (logging in on the old
 * vercel.app host, where the Domain=percolator.trade `privy-session` cookie can never be visible)
 * is removed by the old-host redirect + legacy-token purge (PR #2950); this is the last-resort
 * escape for whatever is left.
 *
 * What it touches, and why only that:
 *   - `logout()` (Privy SDK): posts the session logout to Privy's API (in HttpOnly-cookie mode the
 *     server clears its own cookies) and then always destroys the local tokens; it swallows its
 *     own network errors (`_destroy(){try{await api.post(...)}catch{}this.destroyLocalState()}`,
 *     toViemAccount-*.mjs).
 *   - Privy's own `privy:*` keys in this origin's localStorage/sessionStorage (tokens, `privy:caid`,
 *     `privy:connections`, OAuth state). Embedded-wallet key material lives in Privy's iframe on its
 *     own origin and is never in this storage. The app's own keys (`percolator:*`) and WalletConnect
 *     keys (`wc@2:*`) are left alone.
 *   - NOT the `privy-*` cookies. `privy-session` is Domain=percolator.trade and shared with the
 *     waitlist site, which reads `privy-token` / `privy-id-token` server-side; deleting it from JS
 *     would sign the user out of percolator.trade too and can race Privy's own cookie handling.
 *     Server-set cookies are Privy's to clear via `logout()`.
 *
 * Compatible with PR #2950's `purgeLegacyPrivyState()`: that runs once at module load and only
 * removes the four token keys when they hold a legacy (non-"deprecated") refresh token. After this
 * sweep those keys are absent, so on the reload the purge finds nothing and is a no-op.
 */

const PRIVY_STORAGE_PREFIX = "privy:";

function clearStorage(storage: Storage | undefined): number {
  if (!storage) return 0;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(PRIVY_STORAGE_PREFIX)) keys.push(k);
  }
  keys.forEach((k) => storage.removeItem(k));
  return keys.length;
}

/** Removes Privy's own `privy:*` storage keys. Returns how many were removed. Never throws. */
export function clearPrivyBrowserState(): number {
  if (typeof window === "undefined") return 0;
  let n = 0;
  try {
    n += clearStorage(window.localStorage);
  } catch {
    /* storage blocked */
  }
  try {
    n += clearStorage(window.sessionStorage);
  } catch {
    /* storage blocked */
  }
  return n;
}

/**
 * Full reset: Privy `logout()`, then the storage sweep, then `reload` so the SDK re-initialises from
 * clean storage. Does not open any wallet prompt and never signs.
 */
export async function resetPrivyConnection(
  logout: () => Promise<void> | void,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  try {
    await logout();
  } catch {
    /* no session to log out of */
  }
  clearPrivyBrowserState();
  reload();
}
