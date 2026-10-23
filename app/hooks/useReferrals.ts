"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivyBridge } from "@/hooks/usePrivyBridge";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { waitlistOrigin, type ReferralsResponse } from "@/lib/referrals";

export type ReferralsState = { status: "loading" } | { status: "error" } | ReferralsResponse;

/** How often an open, visible tab re-reads the joined count. The server reuses a count for 60s. */
export const REFERRALS_REFRESH_MS = 120_000;

/**
 * The signed-in user's referral link and joined count (GET /api/playground/referrals). The route checks
 * this request's Privy login against the session, so the access token is sent with every read.
 *
 * The count keeps up as people join: while the page is visible it is re-read every
 * REFERRALS_REFRESH_MS, and again whenever the page becomes visible. Only the first read (and Try again)
 * shows the loading state; later reads run in the background, and:
 *   - a read that fails, or cannot count, keeps what is on screen;
 *   - a loaded link is replaced by a different answer (signed out, not linked) only when two background
 *     reads in a row agree, so one transient hiccup cannot swap a good screen for a notice.
 */
export function useReferrals(): { state: ReferralsState; retry: () => void } {
  const privyAvailable = usePrivyAvailable();
  const { ready, authenticated, getAccessToken } = usePrivyBridge();
  const [state, setStateRaw] = useState<ReferralsState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** The state on screen, readable outside render so decisions never run inside a state updater. */
  const current = useRef<ReferralsState>(state);
  const setState = useCallback((next: ReferralsState) => {
    current.current = next;
    setStateRaw(next);
  }, []);
  /** Something real is on screen, so later reads run in the background. */
  const shown = useRef(false);
  /** A background read disagreed with the loaded link once; the next disagreement is believed. */
  const doubted = useRef(false);

  useEffect(() => {
    // Without Privy the bridge never becomes ready; offer to enter again instead of loading forever.
    if (!privyAvailable) {
      shown.current = false;
      setState({ status: "unavailable", enterUrl: `${waitlistOrigin()}/playground` });
      return;
    }
    if (!ready) return;
    if (!authenticated) {
      shown.current = false;
      setState({ status: "signed-out" });
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const apply = (next: ReferralsState, background: boolean) => {
      const prev = current.current;
      if (!background || prev.status !== "ok") {
        doubted.current = false;
        setState(next);
        return;
      }
      if (next.status === "ok") {
        doubted.current = false;
        // A background read that could not count keeps the count already on screen.
        setState(next.joined === null && next.code === prev.code ? { ...next, joined: prev.joined } : next);
        return;
      }
      if (!doubted.current) {
        doubted.current = true; // keep the loaded link; believe it only if the next read agrees
        return;
      }
      doubted.current = false;
      setState(next);
    };

    const load = async (background: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (!background) setState({ status: "loading" });
      try {
        const token = await getAccessToken();
        if (cancelled) return;
        if (!token) {
          apply({ status: "signed-out" }, background);
          return;
        }
        const res = await fetch("/api/playground/referrals", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          if (!background) setState({ status: "error" });
          return;
        }
        const body = (await res.json()) as ReferralsResponse;
        if (cancelled) return;
        apply(body, background);
      } catch {
        if (!cancelled && !background) setState({ status: "error" });
      } finally {
        inFlight = false;
        if (!cancelled) shown.current = true;
      }
    };

    void load(shown.current);

    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) void load(true);
    }, REFERRALS_REFRESH_MS);
    const onVisibility = () => {
      if (visible()) void load(true);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [privyAvailable, ready, authenticated, getAccessToken, attempt, setState]);

  const retry = useCallback(() => {
    shown.current = false;
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
}
