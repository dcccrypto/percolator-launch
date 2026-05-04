"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  discoverMarkets,
  discoverMarketsViaApi,
  discoverMarketsViaStaticBundle,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { getAllProgramIds, getNetwork } from "@/lib/config";
import { isBlockedSlab } from "@/lib/blocklist";

const MAINNET_STATIC_MARKETS = [
  {
    slabAddress: "AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J",
    symbol: "SOL-PERP",
    name: "SOL/USD Perpetual",
  },
];

/** Get all unique program PublicKeys to scan */
function getProgramPublicKeys(): PublicKey[] {
  return getAllProgramIds().map((id) => new PublicKey(id));
}

function getApiBaseUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URL("/api", window.location.origin).toString();
}

async function discoverForProgram(
  connection: ReturnType<typeof useConnectionCompat>["connection"],
  programId: PublicKey,
): Promise<DiscoveredMarket[]> {
  const network = getNetwork();
  const apiBaseUrl = getApiBaseUrl();

  // In-browser getProgramAccounts tier scans are expensive and can trigger
  // RPC batch drops. Prefer the app API as an address directory, then fetch
  // the returned slabs with getMultipleAccounts through the normal connection.
  if (apiBaseUrl) {
    const viaApi = await discoverMarketsViaApi(connection, programId, apiBaseUrl, {
      timeoutMs: 8_000,
    }).catch(() => [] as DiscoveredMarket[]);
    if (viaApi.length > 0) return viaApi;
  }

  if (network === "mainnet") {
    const viaStatic = await discoverMarketsViaStaticBundle(
      connection,
      programId,
      MAINNET_STATIC_MARKETS,
    ).catch(() => [] as DiscoveredMarket[]);
    if (viaStatic.length > 0) return viaStatic;
  }

  // Last resort: keep the SDK scanner, but run it sequentially so a fallback
  // discovery attempt cannot burst multiple getProgramAccounts calls at once.
  return discoverMarkets(connection, programId, {
    sequential: true,
    maxParallelTiers: 1,
    apiBaseUrl,
    network,
  }).catch(() => [] as DiscoveredMarket[]);
}

/**
 * Discovers all Percolator markets across all known program deployments.
 */
export function useMarketDiscovery() {
  const { connection } = useConnectionCompat();
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const programIds = getProgramPublicKeys();
    if (programIds.length === 0) {
      setLoading(false);
      setError("PROGRAM_ID not configured");
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const results = await Promise.all(
          programIds.map((pid) => discoverForProgram(connection, pid))
        );
        if (!cancelled) {
          // GH#1115: deduplicate across program-ID scans — same slab can appear from
          // multiple discoverMarkets calls if programsBySlabTier overlaps with programId.
          // GH#1189: also filter out blocked slab addresses from the on-chain discovery
          // path. PR #1186 only patched the Supabase path; this closes the on-chain gap.
          const seenSlabs = new Set<string>();
          const flat = results.flat().filter((m) => {
            const addr = m.slabAddress.toBase58();
            if (seenSlabs.has(addr)) return false;
            seenSlabs.add(addr);
            if (isBlockedSlab(addr)) return false; // GH#1189: exclude blocked slabs
            return true;
          });
          setMarkets(flat);
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
