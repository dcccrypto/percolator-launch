"use client";

import useSWR from "swr";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  discoverMarketsViaStaticBundle,
  type DiscoveredMarket,
} from "@percolatorct/sdk";
import { getAllProgramIds, getNetwork } from "@/lib/config";
import { isBlockedSlab } from "@/lib/blocklist";
import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";

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
    const viaApi = await discoverMarketsViaProgramDirectory(connection, programId, apiBaseUrl, {
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

  // Do not run getProgramAccounts tier scans from the browser. They are too
  // expensive for public RPCs and can trigger repeated batch failures when the
  // API/static directory is unavailable.
  return [];
}

/**
 * Discovers all Percolator markets across all known program deployments.
 *
 * Uses SWR to deduplicate concurrent fetches when multiple components mount
 * this hook simultaneously (React Strict Mode double-invocation, multiple
 * consumers on the same page). A single in-flight request is shared per
 * (endpoint × program-ID set) key for the 30-second dedup window.
 */
export function useMarketDiscovery() {
  const { connection } = useConnectionCompat();
  const programIds = getProgramPublicKeys();

  // Stable SWR key encodes endpoint + sorted program IDs.
  // null → SWR skips the fetch (no programs configured).
  const swrKey = programIds.length > 0
    ? `market-discovery:${connection.rpcEndpoint}:${programIds.map((p) => p.toBase58()).sort().join(",")}`
    : null;

  const { data, error, isLoading, mutate } = useSWR<DiscoveredMarket[], Error>(
    swrKey,
    async () => {
      const results = await Promise.all(
        programIds.map((pid) => discoverForProgram(connection, pid))
      );
      // GH#1115: deduplicate across program-ID scans — same slab can appear from
      // multiple discoverMarkets calls if programsBySlabTier overlaps with programId.
      // GH#1189: also filter out blocked slab addresses from the on-chain discovery
      // path. PR #1186 only patched the Supabase path; this closes the on-chain gap.
      const seenSlabs = new Set<string>();
      return results.flat().filter((m) => {
        const addr = m.slabAddress.toBase58();
        if (seenSlabs.has(addr)) return false;
        seenSlabs.add(addr);
        if (isBlockedSlab(addr)) return false;
        return true;
      });
    },
    {
      // Collapse all concurrent hook instances to 1 request per key per 30 s.
      dedupingInterval: 30_000,
      // Replace the manual setInterval — SWR refetches in the background.
      refreshInterval: 30_000,
      revalidateOnFocus: false,
    },
  );

  return {
    markets: data ?? [],
    loading: isLoading,
    error: programIds.length === 0
      ? "PROGRAM_ID not configured"
      : error instanceof Error
        ? error.message
        : error
          ? String(error)
          : null,
    /** Trigger an immediate re-fetch (e.g., after market creation). */
    refetch: mutate,
  };
}
