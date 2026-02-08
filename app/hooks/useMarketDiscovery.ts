"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { discoverMarkets, type DiscoveredMarket } from "@percolator/core";
import { config } from "@/lib/config";

/**
 * Discovers all Percolator markets on-chain.
 */
export function useMarketDiscovery() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config.programId) {
      setLoading(false);
      setError("PROGRAM_ID not configured");
      return;
    }

    let cancelled = false;
    const programId = new PublicKey(config.programId);

    async function load() {
      try {
        const result = await discoverMarkets(connection, programId);
        if (!cancelled) {
          setMarkets(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [connection]);

  return { markets, loading, error };
}
