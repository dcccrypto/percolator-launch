"use client";

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useMarketDiscovery } from "./useMarketDiscovery";
import type { DiscoveredMarket } from "@percolator/core";

export interface MyMarket extends DiscoveredMarket {
  /** Formatted label for display */
  label: string;
}

export function useMyMarkets() {
  const { publicKey } = useWallet();
  const { markets, loading, error } = useMarketDiscovery();

  const myMarkets = useMemo<MyMarket[]>(() => {
    if (!publicKey || !markets.length) return [];
    const walletStr = publicKey.toBase58();
    return markets
      .filter((m) => m.header.admin.toBase58() === walletStr)
      .map((m) => ({
        ...m,
        label: m.slabAddress.toBase58().slice(0, 8) + "…",
      }));
  }, [publicKey, markets]);

  return { myMarkets, loading, error, connected: !!publicKey };
}
