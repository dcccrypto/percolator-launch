"use client";

import { FC, ReactNode, Suspense } from "react";
import { useMarketAddress } from "@/hooks/useMarketAddress";
import { SlabProvider } from "@/components/providers/SlabProvider";

const Inner: FC<{ children: ReactNode }> = ({ children }) => {
  const slabAddress = useMarketAddress();
  return <SlabProvider slabAddress={slabAddress}>{children}</SlabProvider>;
};

/**
 * Wraps SlabProvider with dynamic market address from `?market=` query param.
 * Suspense boundary required by Next.js 16 for useSearchParams.
 */
export const MarketProvider: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <Suspense fallback={null}>
      <Inner>{children}</Inner>
    </Suspense>
  );
};
