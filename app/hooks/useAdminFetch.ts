"use client";

import { useCallback, useRef } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";

/**
 * Hook returning a `fetch`-like function that automatically attaches
 * the caller's Privy access token + id token to outgoing requests.
 *
 * Critical: the returned function MUST be referentially stable across
 * renders. The previous version listed `getAccessToken` and
 * `identityToken` as deps on `useCallback`; both change identity on
 * every render from Privy, which made consumers thrash —
 * `useEffect(..., [adminFetch])` re-fired every render, SWR
 * (`useSWR(key, adminFetch)`) re-keyed every render, both causing
 * runaway request loops against /api/admin/whoami.
 *
 * Fix: capture the live Privy values in refs and reassign on every
 * render. The returned callback closes over the refs, not the values,
 * so its identity stays constant. Inside the callback we read
 * `.current` to get whatever Privy returned most recently.
 */
export function useAdminFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  const { getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();

  const getAccessTokenRef = useRef(getAccessToken);
  const identityTokenRef = useRef(identityToken);
  getAccessTokenRef.current = getAccessToken;
  identityTokenRef.current = identityToken;

  return useCallback(async (input, init) => {
    const accessToken = await getAccessTokenRef.current();
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    if (identityTokenRef.current) headers["x-privy-id-token"] = identityTokenRef.current;
    return fetch(input, { ...init, headers });
  }, []);
}
