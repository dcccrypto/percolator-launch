"use client";

import { useEffect, useState } from "react";

/**
 * Resolves a token's real DEX logo by **mainnet contract address** via
 * /api/token-logo/[mint] (GeckoTerminal → DexScreener, edge-cached 24h).
 *
 * Module-level cache + in-flight dedup: multiple MarketLogo instances asking
 * about the same mint (e.g. the markets list + the switcher dropdown) share
 * one request instead of one each. Mirrors the cache pattern in lib/tokenMeta.ts.
 */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

async function fetchTokenLogo(mainnetCa: string): Promise<string | null> {
  const cached = cache.get(mainnetCa);
  if (cached !== undefined) return cached;

  let promise = inflight.get(mainnetCa);
  if (!promise) {
    promise = fetch(`/api/token-logo/${mainnetCa}`, { signal: AbortSignal.timeout(6000) })
      .then((res) => (res.ok ? res.json() : { logoUrl: null }))
      .then((data: { logoUrl?: string | null }) =>
        typeof data?.logoUrl === "string" ? data.logoUrl : null,
      )
      .catch(() => null)
      .finally(() => inflight.delete(mainnetCa));
    inflight.set(mainnetCa, promise);
  }

  const result = await promise;
  cache.set(mainnetCa, result);
  return result;
}

/**
 * React hook wrapping fetchTokenLogo. Returns null while loading, when no
 * mint is given, or when neither GeckoTerminal nor DexScreener have a logo
 * for this mint — callers fall back to the symbol-initials placeholder in
 * all of those cases (see components/market/MarketLogo.tsx).
 *
 * Never blocks render: fires the fetch async and returns null immediately,
 * updating once the (cached-or-fresh) result resolves.
 */
export function useTokenLogo(mainnetCa: string | null | undefined): string | null {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!mainnetCa) {
      setLogoUrl(null);
      return;
    }

    // Clear the previous mint's logo immediately so switching tokens never
    // flashes the old image while the new one resolves.
    setLogoUrl(null);

    let cancelled = false;
    fetchTokenLogo(mainnetCa).then((url) => {
      if (!cancelled) setLogoUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [mainnetCa]);

  return logoUrl;
}
