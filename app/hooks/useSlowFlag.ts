"use client";

import { useEffect, useState } from "react";

/** The trade ticket's button while the first portfolio scan of a connected wallet has not answered. */
export const ACCOUNT_LOADING_COPY = {
  loading: "Loading account…",
  /** Shown after SLOW_ACCOUNT_SCAN_MS: the scan is slow or failing and is being retried (calm, one line). */
  slow: "Still loading your account. Retrying…",
} as const;

export const SLOW_ACCOUNT_SCAN_MS = 15_000;

/** True once `active` has been continuously true for `afterMs`; false again as soon as it turns false. */
export function useSlowFlag(active: boolean, afterMs: number = SLOW_ACCOUNT_SCAN_MS): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(t);
  }, [active, afterMs]);
  return active && slow;
}
