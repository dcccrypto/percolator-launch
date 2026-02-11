"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { discoverMarkets, type DiscoveredMarket } from "@percolator/core";
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

/** Backend API market shape */
interface ApiMarket {
  slabAddress: string;
  programId: string;
  admin: string;
  resolved: boolean;
  mint: string;
  vault: string;
  oracleAuthority: string;
  indexFeedId: string;
  authorityPriceE6: string;
  lastEffectivePriceE6: string;
  totalOpenInterest: string;
  cTot: string;
  insuranceFundBalance: string;
  numUsedAccounts: number;
  lastCrankSlot: string;
  initialMarginBps: string;
  maintenanceMarginBps: string;
}

/**
 * Convert backend API market to DiscoveredMarket shape for compatibility
 * with existing frontend components.
 */
function apiToDiscovered(m: ApiMarket): DiscoveredMarket {
  return {
    slabAddress: new PublicKey(m.slabAddress),
    programId: new PublicKey(m.programId),
    header: {
      magic: 0n,
      version: 0,
      admin: new PublicKey(m.admin),
      resolved: m.resolved,
    },
    config: {
      collateralMint: new PublicKey(m.mint),
      vaultPubkey: new PublicKey(m.vault),
      oracleAuthority: new PublicKey(m.oracleAuthority),
      indexFeedId: new PublicKey(m.indexFeedId),
      authorityPriceE6: BigInt(m.authorityPriceE6),
      lastEffectivePriceE6: BigInt(m.lastEffectivePriceE6),
    },
    engine: {
      vault: BigInt(m.cTot),
      totalOpenInterest: BigInt(m.totalOpenInterest),
      cTot: BigInt(m.cTot),
      numUsedAccounts: m.numUsedAccounts,
      lastCrankSlot: BigInt(m.lastCrankSlot),
      insuranceFund: { balance: BigInt(m.insuranceFundBalance) },
    },
    params: {
      initialMarginBps: BigInt(m.initialMarginBps),
      maintenanceMarginBps: BigInt(m.maintenanceMarginBps),
    },
  } as unknown as DiscoveredMarket;
}

/**
 * Fetch full market data from backend API (no RPC calls needed).
 */
async function fetchMarketsFromApi(): Promise<DiscoveredMarket[] | null> {
  if (!BACKEND_URL) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/markets`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const markets = (data.markets ?? []) as ApiMarket[];
    return markets.map(apiToDiscovered);
  } catch {
    return null;
  }
}

/**
 * Discovers all Percolator markets.
 *
 * Strategy:
 * 1. Fetch full market data from backend API (fast, no RPC calls)
 * 2. Fallback: direct RPC discovery via getProgramAccounts (sequential with delays)
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
        // Strategy 1: Full market data from backend API (no RPC needed)
        let discovered = await fetchMarketsFromApi();

        // Strategy 2: Fallback to direct RPC discovery (sequential)
        if (!discovered || discovered.length === 0) {
          const allFound: DiscoveredMarket[] = [];
          for (const pid of programIds) {
            try {
              const found = await discoverMarkets(connection, pid);
              allFound.push(...found);
            } catch {
              // Silently skip — may be rate limited
            }
            await new Promise((r) => setTimeout(r, 1_500));
          }
          discovered = allFound;
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
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [connection]);

  return { markets, loading, error };
}
