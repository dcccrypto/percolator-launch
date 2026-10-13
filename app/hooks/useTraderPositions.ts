"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { fetchPortfolioSnapshot, isOpenPosition, type PortfolioPosition } from "@/hooks/usePortfolio";
import { getMarketDiscoveryProgramIds } from "@/lib/config";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

/** Open positions are re-read this often while the profile is open. */
const REFRESH_MS = 60_000;

/**
 * Open positions of ANY wallet (read-only), for the public /trader/<wallet> profile.
 *
 * Uses the same snapshot loader as the connected wallet's portfolio (fetchPortfolioSnapshot), which
 * fails closed: a failed or partial scan rejects instead of returning a short list. On a failed
 * refresh the last good list is kept and only an initial failure surfaces as an error, so an RPC
 * blip never renders as "no open positions".
 */
export function useTraderPositions(wallet: string | null): {
  positions: PortfolioPosition[];
  loading: boolean;
  error: string | null;
} {
  const { connection } = useConnectionCompat();
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [loading, setLoading] = useState(!!wallet);
  const [error, setError] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(
    async (isCancelled: () => boolean) => {
      if (!wallet) return;
      // Design preview only (?mock=1, never in a production build; see isMockMode): the same
      // synthetic book the dock, liquidation card and other-markets rows use.
      if (isMockMode()) {
        setPositions(getMockPortfolioPositions().filter(isOpenPosition));
        setError(null);
        setLoading(false);
        return;
      }
      try {
        const snap = await fetchPortfolioSnapshot(connection, new PublicKey(wallet), getMarketDiscoveryProgramIds());
        if (isCancelled()) return;
        setPositions(snap.positions.filter(isOpenPosition));
        setError(null);
        loadedFor.current = wallet;
      } catch {
        if (isCancelled()) return;
        if (loadedFor.current !== wallet) setError("Couldn't load open positions. Try again in a moment.");
      } finally {
        if (!isCancelled()) setLoading(false);
      }
    },
    [wallet, connection],
  );

  useEffect(() => {
    setPositions([]);
    setError(null);
    setLoading(!!wallet);
    loadedFor.current = null;
    if (!wallet) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    void load(isCancelled);
    const t = setInterval(() => void load(isCancelled), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [wallet, load]);

  return { positions, loading, error };
}
