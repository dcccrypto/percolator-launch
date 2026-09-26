"use client";

/**
 * Per-slab market identity (ticker / name / logo / CA) for a list of markets,
 * resolved WITHOUT waiting on the per-market detail fetch.
 *
 * Two sources, both fast, in precedence order:
 *
 *   1. the cross-navigation identity cache (lib/marketIdentityCache.ts) —
 *      SYNCHRONOUS, so a return visit paints the real tickers on the first
 *      committed render. /my-markets already WROTE this cache on every resolve
 *      and never read it back, so it re-showed placeholders for a full second
 *      with the answer already in memory.
 *   2. the bulk directory `/api/markets?limit=500` — ONE request for every
 *      market, measured at 117-192ms against the deployed playground, versus
 *      517-1022ms per market for `/api/markets/[slab]` (which blocks on an
 *      on-chain LP scan before it answers).
 *
 * This hook deliberately does NOT return numbers. Identity and the per-market
 * financial detail resolve on different clocks, and merging them into one map
 * is what let identity-only entries be counted as "resolved" and a $0.00
 * aggregate be published as a finished figure. Keeping them apart is the point:
 * see useCreatorMarketDetails, whose map stays fetch-only.
 */

import { useEffect, useMemo, useState } from "react";
import { getMarketIdentity, setMarketIdentity } from "@/lib/marketIdentityCache";
import { parseBulkIdentities, resolveIdentity, hasAnyIdentity, type ResolvedIdentity } from "@/lib/bulk-identity";
import { seedFromCache } from "@/lib/incremental-details";

/** Directory page size. The creator dashboard needs identity for markets the
 *  wallet owns, which are a subset of the directory — the same limit the
 *  portfolio snapshot uses for the same lookup (hooks/usePortfolio.ts). */
const DIRECTORY_LIMIT = 500;

/** The bulk call is a nice-to-have on top of the cache seed: if it is slow the
 *  per-market details will answer anyway, so give up rather than hold a
 *  request open. Matches the 8s budget usePortfolio uses for the same URL. */
const DIRECTORY_TIMEOUT_MS = 8_000;

export function useMarketIdentities(slabs: string[]): Record<string, ResolvedIdentity> {
  const slabsKey = useMemo(() => [...slabs].sort().join(","), [slabs]);
  const [identities, setIdentities] = useState<Record<string, ResolvedIdentity>>({});

  useEffect(() => {
    const list = slabsKey ? slabsKey.split(",") : [];
    if (list.length === 0) {
      setIdentities({});
      return;
    }

    // Synchronous, before any request: whatever this session already knows.
    const seeded = seedFromCache<ResolvedIdentity>(list, (slab) => {
      const cached = getMarketIdentity(slab);
      if (!cached) return null;
      const identity = resolveIdentity(cached);
      return hasAnyIdentity(identity) ? identity : null;
    });
    setIdentities(seeded);

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/markets?limit=${DIRECTORY_LIMIT}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { markets?: unknown };
        const fromDirectory = parseBulkIdentities(body.markets, list);
        if (cancelled) return;

        // Per FIELD, not per entry: the directory's field set varies by
        // deployment (it returned symbol+name but no logo_url/mainnet_ca on the
        // deployment measured), so it must sharpen the seed, never blank it.
        setIdentities((prev) => {
          const next: Record<string, ResolvedIdentity> = { ...prev };
          for (const slab of Object.keys(fromDirectory)) {
            next[slab] = resolveIdentity(fromDirectory[slab], prev[slab]);
          }
          return next;
        });

        // Feed the cross-navigation cache so /trade/[slab] and the switcher get
        // the same head start this page just got. Merge-write, so this cannot
        // blank a field a richer source already stored.
        for (const slab of Object.keys(fromDirectory)) {
          const id = fromDirectory[slab];
          setMarketIdentity(slab, {
            symbol: id.symbol ?? undefined,
            name: id.name ?? undefined,
            logo_url: id.logo_url ?? undefined,
            mainnet_ca: id.mainnet_ca,
          });
        }
      } catch {
        // Timeout, offline, or malformed body: the cache seed stands and the
        // per-market details still resolve. Nothing to report to the user.
      }
    })();

    return () => { cancelled = true; };
  }, [slabsKey]);

  return identities;
}
