"use client";

import { useEffect, useState } from "react";
import { usePrivy, useIdentityToken } from "@privy-io/react-auth";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";

export type WhoamiState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "not-found" }
  | {
      status: "found";
      referralCode: string;
      position: number | null;
    }
  | { status: "error"; reason: string };

/**
 * Polls /api/waitlist/whoami exactly once when the user becomes
 * Privy-authenticated. Backed by server-side Privy session verification,
 * so the result is trustworthy.
 *
 * Three terminal states the consumer cares about:
 *   • idle / checking — render the existing signup form
 *   • found           — render the welcome-back card (skip signup)
 *   • not-found       — render the signup form (this Privy user has
 *                       never joined the waitlist)
 *
 * The hook never blocks the rest of the page from rendering. If the
 * fetch errors (network, server, 5xx), it falls back to "not-found"
 * so the user can still complete a signup manually.
 */
export function useWaitlistWhoami(): WhoamiState {
  const privyAvailable = usePrivyAvailable();
  const { ready, authenticated, getAccessToken } = usePrivy();
  // useIdentityToken only works inside PrivyProvider. The hook itself
  // is null-safe at runtime, but TypeScript wants us to call it
  // unconditionally — we guard the *use* of the result instead.
  const { identityToken } = useIdentityToken();
  const [state, setState] = useState<WhoamiState>({ status: "idle" });

  useEffect(() => {
    if (!privyAvailable) {
      setState({ status: "idle" });
      return;
    }
    if (!ready) return;
    if (!authenticated) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    (async () => {
      setState({ status: "checking" });
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          if (!cancelled) setState({ status: "not-found" });
          return;
        }
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
        };
        if (identityToken) headers["x-privy-id-token"] = identityToken;

        const res = await fetch("/api/waitlist/whoami", {
          method: "POST",
          headers,
        });
        if (cancelled) return;
        if (res.status === 503) {
          // Server isn't configured for Privy (no PRIVY_APP_SECRET).
          // Falling back to not-found lets the signup form keep working.
          setState({ status: "not-found" });
          return;
        }
        if (!res.ok) {
          setState({ status: "not-found" });
          return;
        }
        const json = (await res.json()) as {
          found?: boolean;
          referral_code?: string | null;
          position?: number | null;
        };
        if (json.found && json.referral_code) {
          setState({
            status: "found",
            referralCode: json.referral_code,
            position: typeof json.position === "number" ? json.position : null,
          });
        } else {
          setState({ status: "not-found" });
        }
      } catch (err) {
        if (cancelled) return;
        console.warn("[whoami] fetch failed", err);
        setState({
          status: "error",
          reason: err instanceof Error ? err.message : "unknown",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [privyAvailable, ready, authenticated, getAccessToken, identityToken]);

  return state;
}
