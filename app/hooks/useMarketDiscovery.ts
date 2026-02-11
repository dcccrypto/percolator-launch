"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  discoverMarkets,
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  parseParams,
  type DiscoveredMarket,
} from "@percolator/core";
import { getConfig } from "@/lib/config";

const BACKEND_URL = process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") ?? "";

/** Get all unique program IDs to scan (default + all slab tier programs) */
function getAllProgramIds(): PublicKey[] {
  const cfg = getConfig();
  const ids = new Set<string>([cfg.programId]);
  const byTier = (cfg as any).programsBySlabTier as Record<string, string> | undefined;
  if (byTier) {
    Object.values(byTier).forEach((id) => ids.add(id));
  }
  return [...ids].map((id) => new PublicKey(id));
}

/**
 * Try fetching market list from backend API first (fast, no RPC rate limits).
 * Returns slab addresses that the backend has discovered.
 */
async function fetchBackendMarketAddrs(): Promise<string[] | null> {
  if (!BACKEND_URL) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/markets`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const markets = data.markets as Array<{ slabAddress: string }>;
    return markets.map((m) => m.slabAddress);
  } catch {
    return null;
  }
}

/**
 * Discovers all Percolator markets across all known program deployments.
 *
 * Strategy:
 * 1. Ask backend API which slabs exist (fast, no rate limits)
 * 2. Fetch each slab individually via getAccountInfo (cheap, not rate-limited)
 * 3. Fallback: full getProgramAccounts scan (sequential with delays)
 */
export function useMarketDiscovery() {
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const programIds = getAllProgramIds();
    if (programIds.length === 0) {
      setLoading(false);
      setError("PROGRAM_ID not configured");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        let discovered: DiscoveredMarket[] = [];

        // Strategy 1: Backend API → individual slab fetches
        const backendAddrs = await fetchBackendMarketAddrs();
        if (backendAddrs && backendAddrs.length > 0) {
          const results = await Promise.allSettled(
            backendAddrs.map(async (addr) => {
              const pubkey = new PublicKey(addr);
              const info = await connection.getAccountInfo(pubkey);
              if (!info) return null;
              const data = Buffer.from(info.data);
              return {
                slabAddress: pubkey,
                programId: info.owner,
                header: parseHeader(data),
                config: parseConfig(data),
                engine: parseEngine(data),
                params: parseParams(data),
              } as DiscoveredMarket;
            })
          );
          discovered = results
            .filter((r): r is PromiseFulfilledResult<DiscoveredMarket | null> => r.status === "fulfilled")
            .map((r) => r.value)
            .filter((v): v is DiscoveredMarket => v !== null);
        }

        // Strategy 2: Fallback to full discovery if backend returned nothing
        if (discovered.length === 0) {
          for (const pid of programIds) {
            try {
              const found = await discoverMarkets(connection, pid);
              discovered.push(...found);
            } catch {
              // Silently skip — may be rate limited
            }
            // Delay between programs to avoid 429
            await new Promise((r) => setTimeout(r, 1_500));
          }
        }

        if (!cancelled) {
          setMarkets(discovered);
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

    // Refetch every 30 seconds
    const interval = setInterval(load, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connection]);

  return { markets, loading, error };
}
