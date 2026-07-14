/**
 * PERC-356: Auto-fund provider
 *
 * Triggers the auto-fund hook when a wallet connects on devnet, and shares the
 * result via React Context so `useAutoDeposit` can react to it without creating
 * a second `useAutoFund` instance (which caused race conditions — GH #1120).
 */

"use client";

import { createContext, FC, ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAutoFund, type AutoFundResult } from "@/hooks/useAutoFund";

interface AutoFundContextValue {
  /**
   * Auto-fund result. `funded` is true only within a 30-second window after the
   * auto-fund API call succeeds. After the window closes, `result` resets to null
   * to prevent stale `funded: true` from triggering auto-deposit on subsequent
   * trade page navigations (GH #1120).
   */
  result: AutoFundResult | null;
  funding: boolean;
}

const AutoFundContext = createContext<AutoFundContextValue>({
  result: null,
  funding: false,
});

/**
 * Read the auto-fund result from the nearest `AutoFundProvider`.
 * Returns `{ result, funding }` — result is null until the auto-fund API resolves,
 * and resets to null 30s after funding completes.
 */
export function useAutoFundResult(): AutoFundContextValue {
  return useContext(AutoFundContext);
}

/** How long (ms) after funding completes that the result stays available */
const FUNDED_WINDOW_MS = 30_000;

export const AutoFundProvider: FC<{ children?: ReactNode }> = ({ children }) => {
  const { result: rawResult, funding } = useAutoFund();
  const [windowedResult, setWindowedResult] = useState<AutoFundResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!rawResult?.funded) {
      setWindowedResult(rawResult);
      return;
    }

    // Fund just completed — expose result and start expiry timer
    setWindowedResult(rawResult);

    // After the window, clear the result so late-mounting useAutoDeposit instances
    // (e.g. navigating to a second trade page) do NOT trigger the Privy modal.
    timerRef.current = setTimeout(() => {
      setWindowedResult(null);
    }, FUNDED_WINDOW_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [rawResult]);

  const value = useMemo(() => ({ result: windowedResult, funding }), [windowedResult, funding]);

  return (
    <AutoFundContext.Provider value={value}>
      {children ?? null}
    </AutoFundContext.Provider>
  );
};
