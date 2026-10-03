/**
 * One-shot purge of legacy (pre-HttpOnly-cookie) Privy localStorage state.
 *
 * Why (issue #2862, ledger/privy-logout-loop-rootcause-2026-10-02.md, F3):
 * Privy runs in server-cookie mode here (custom_api_url = privy.percolator.trade).
 * In that mode the SDK stores the sentinel "deprecated" in `privy:refresh_token`.
 * A browser that logged in BEFORE the switch still holds a REAL refresh token
 * there. On boot the SDK posts it to /api/v1/sessions, gets a 401, and the
 * server answers by deleting the shared Domain=percolator.trade `privy-*`
 * cookies, which signs the user out of percolator.trade AND play.percolator.trade.
 * Dropping the legacy tokens first turns that into a plain local sign-out.
 *
 * Key names and encoding verified against @privy-io/react-auth 3.41.0:
 *   privy:token, privy:refresh_token, privy:pat, privy:id_token
 *   values are written via JSON.stringify (storage class `k` in storage-*.mjs),
 *   so the cookie-mode placeholder is stored as the JSON string `"deprecated"`.
 *
 * Never touches `privy-*` cookies, the preferred-wallet key or WalletConnect
 * keys: only the four token keys below are removed.
 */

export const PRIVY_LEGACY_TOKEN_KEYS = [
  "privy:token",
  "privy:refresh_token",
  "privy:pat",
  "privy:id_token",
] as const;

const REFRESH_KEY = "privy:refresh_token";
const COOKIE_MODE_PLACEHOLDER = "deprecated";

/** Returns true when legacy tokens were found and removed. Never throws. */
export function purgeLegacyPrivyState(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const storage = window.localStorage;
    const raw = storage.getItem(REFRESH_KEY);
    if (raw === null) return false;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      // Not valid JSON: the SDK itself would throw on read and wipe it. Legacy.
      decoded = raw;
    }
    // Only a string refresh token can be sent to /sessions. Anything else is
    // already ignored by the SDK, so leave it alone.
    if (typeof decoded !== "string" || decoded === COOKIE_MODE_PLACEHOLDER) return false;

    for (const key of PRIVY_LEGACY_TOKEN_KEYS) {
      try {
        storage.removeItem(key);
      } catch {
        /* keep going: best effort per key */
      }
    }
    return true;
  } catch {
    // localStorage can throw (blocked storage, private mode). Never break boot.
    return false;
  }
}
