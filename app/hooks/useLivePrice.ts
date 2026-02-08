"use client";

import { useEffect, useRef, useState } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";

const POLL_MS = 10_000;

/**
 * Fetches the live token/USD price from Jupiter API every 10 seconds.
 */
export function useLivePrice() {
  const [priceUsd, setPriceUsd] = useState<number | null>(null);
  const [priceE6, setPriceE6] = useState<bigint | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const { config: mktConfig } = useSlabState();

  const mint = mktConfig?.collateralMint?.toBase58() ?? null;

  useEffect(() => {
    setPriceUsd(null);
    setPriceE6(null);

    if (!mint) return;

    async function fetchPrice() {
      try {
        const url = `https://api.jup.ag/price/v2?ids=${mint}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const json = await resp.json() as Record<string, unknown>;
        const data = json.data as Record<string, { price?: string }> | undefined;
        if (!data || !data[mint!]) return;
        const p = parseFloat(data[mint!].price ?? "0");
        if (p > 0) {
          setPriceUsd(p);
          setPriceE6(BigInt(Math.round(p * 1_000_000)));
        }
      } catch {
        // keep last known price
      }
    }

    fetchPrice();
    timerRef.current = setInterval(fetchPrice, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [mint]);

  return { priceUsd, priceE6 };
}
