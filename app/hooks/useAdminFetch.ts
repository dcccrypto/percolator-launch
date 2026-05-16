"use client";

import { useCallback } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";

/**
 * Hook returning a `fetch`-like function that automatically attaches
 * the caller's Privy access token + id token to outgoing requests.
 *
 * Use this for any admin API call — /api/admin/* routes verify both
 * tokens server-side via requireAdminSession (Privy + email allowlist
 * check). Pages that aren't logged into Privy will hit 401 on the
 * server and the page-level guard should redirect them to login
 * before that happens.
 *
 * Example:
 *   const adminFetch = useAdminFetch();
 *   const res = await adminFetch("/api/admin/bugs");
 */
export function useAdminFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  const { getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();

  return useCallback(
    async (input, init) => {
      const accessToken = await getAccessToken();
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> | undefined),
      };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
      if (identityToken) headers["x-privy-id-token"] = identityToken;
      return fetch(input, { ...init, headers });
    },
    [getAccessToken, identityToken],
  );
}
