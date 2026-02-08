"use client";

import { useSearchParams } from "next/navigation";

const FALLBACK = process.env.NEXT_PUBLIC_SLAB_ADDRESS ?? "";

/**
 * Reads `?market=<address>` from the URL, falling back to the env-var default.
 * Must be used inside a <Suspense> boundary (Next.js 16 requirement for useSearchParams).
 */
export function useMarketAddress(): string {
  const params = useSearchParams();
  return params.get("market") ?? FALLBACK;
}
