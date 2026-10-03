"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A session that the user just signed in with and that is gone again within this window, without
 * the user logging out, is treated as dropped. The SDK teardown that causes the loop happens within
 * the same few renders as the login (see below), so 10s is generous and still far shorter than any
 * real session.
 */
export const SESSION_DROP_WINDOW_MS = 10_000;

/**
 * Detects the "Connect loops" state (GH#2862 sibling): Privy's modal shows "Successfully connected
 * with <wallet> / Wallet was already linked", and the header is still signed out.
 *
 * What the app actually observes in that loop (@privy-io/react-auth 3.41.0):
 *   - `loginWithSiws` resolves with `setUser(user); setIsNewUser(..); setAuthenticated(true)`
 *     (index-whe5byI0.mjs, `loginWithSiws:C((async(...)=>{... return i(C),r(L||!1),a(!0),C})`), so
 *     `authenticated` IS committed as true for at least one render;
 *   - the always-mounted auto-migrate component (`ir`) then calls `getAccessToken()`; with no
 *     visible `privy-session` cookie the session class runs `destroyLocalState()` →
 *     `onDeleteCustomerAccessToken` → `setUser(null); setAuthenticated(false)` (toViemAccount-*.mjs
 *     `_getToken`, index-whe5byI0.mjs `i.onDeleteCustomerAccessToken=()=>{oa(null),We(!1),...}`);
 *   - the modal is then closed with `user === null`, so `closePrivyModal` fires login `onError`
 *     (USER_EXITED_AUTH_FLOW), NOT `onComplete` (index-whe5byI0.mjs `closePrivyModal`).
 * So the reliable signature is: the user clicked Connect, `authenticated` went true, then false
 * again within SESSION_DROP_WINDOW_MS without a logout the user asked for. A login `onComplete`
 * check never fires in the loop, and counting Connect clicks is reset by the transient `true` and
 * also misfires for users who simply closed the modal twice, so neither is used.
 *
 * Nothing here opens a wallet prompt or signs; the caller decides what to do with the flag.
 */
export function useSignInLoopRecovery(opts: { ready: boolean; authenticated: boolean }) {
  const { ready, authenticated } = opts;
  const [dropped, setDropped] = useState(false);
  /** Set by a Connect click; a session that appears after it is one the user just signed in with. */
  const armed = useRef(false);
  /** When the session from the armed attempt appeared. */
  const authedAt = useRef<number | null>(null);
  /** The user asked for this sign-out (Disconnect / Reset), so it is not a drop. */
  const userLoggedOut = useRef(false);

  /** Call when the user clicks Connect while signed out. */
  const noteConnectAttempt = useCallback(() => {
    armed.current = true;
    userLoggedOut.current = false;
  }, []);

  /** Call right before any logout the user asked for from this component. */
  const noteUserLogout = useCallback(() => {
    userLoggedOut.current = true;
  }, []);

  useEffect(() => {
    if (authenticated) {
      if (armed.current) {
        armed.current = false;
        authedAt.current = Date.now();
      }
      setDropped(false);
      return;
    }
    const since = authedAt.current;
    authedAt.current = null;
    if (since === null) return;
    if (userLoggedOut.current) {
      userLoggedOut.current = false;
      return;
    }
    if (Date.now() - since <= SESSION_DROP_WINDOW_MS) setDropped(true);
  }, [authenticated]);

  const needsReset = ready && !authenticated && dropped;

  return { needsReset, noteConnectAttempt, noteUserLogout };
}
