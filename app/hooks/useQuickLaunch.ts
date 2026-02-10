"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useDexPoolSearch, type DexPoolResult } from "./useDexPoolSearch";
import { fetchTokenMeta } from "@/lib/tokenMeta";

export interface QuickLaunchConfig {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  initialPrice: string;
  maxLeverage: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  tradingFeeBps: number;
  lpCollateral: string;
  liquidityTier: "low" | "medium" | "high";
}

export interface QuickLaunchResult {
  config: QuickLaunchConfig | null;
  loading: boolean;
  error: string | null;
  poolInfo: DexPoolResult | null;
}

/**
 * Auto-detects token metadata and best DEX pool, then suggests
 * sensible market parameters based on liquidity.
 */
export function useQuickLaunch(mint: string | null): QuickLaunchResult {
  const { connection } = useConnection();
  const { pools, loading: poolsLoading } = useDexPoolSearch(mint);
  const [config, setConfig] = useState<QuickLaunchConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null);

  // Fetch on-chain token metadata using shared fetchTokenMeta
  // (checks cache → well-known → Metaplex on-chain → Jupiter, in that order)
  useEffect(() => {
    setTokenMeta(null);
    setError(null);
    if (!mint || mint.length < 32) return;

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const mintPk = new PublicKey(mint);
        const meta = await fetchTokenMeta(connection, mintPk);
        if (!cancelled) {
          setTokenMeta({ name: meta.name, symbol: meta.symbol, decimals: meta.decimals });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Invalid mint");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [mint, connection]);

  // Build config when we have both token meta and pools
  useEffect(() => {
    if (!tokenMeta || !mint) {
      setConfig(null);
      return;
    }

    const bestPool = pools.length > 0 ? pools[0] : null;
    const liquidity = bestPool?.liquidityUsd ?? 0;
    const price = bestPool?.priceUsd ?? 0;

    let tier: "low" | "medium" | "high";
    let initialMarginBps: number;
    let maintenanceMarginBps: number;
    let maxLeverage: number;
    let tradingFeeBps: number;

    if (liquidity < 10_000) {
      tier = "low";
      initialMarginBps = 2000;
      maintenanceMarginBps = 1000;
      maxLeverage = 5;
      tradingFeeBps = 20;
    } else if (liquidity < 100_000) {
      tier = "medium";
      initialMarginBps = 1500;
      maintenanceMarginBps = 750;
      maxLeverage = 6;
      tradingFeeBps = 10;
    } else {
      tier = "high";
      initialMarginBps = 1000;
      maintenanceMarginBps = 500;
      maxLeverage = 10;
      tradingFeeBps = 5;
    }

    setConfig({
      mint,
      name: tokenMeta.name,
      symbol: tokenMeta.symbol,
      decimals: tokenMeta.decimals,
      initialPrice: price > 0 ? price.toFixed(6) : "1.000000",
      maxLeverage,
      initialMarginBps,
      maintenanceMarginBps,
      tradingFeeBps,
      lpCollateral: "1000",
      liquidityTier: tier,
    });
  }, [tokenMeta, pools, mint]);

  const bestPool = pools.length > 0 ? pools[0] : null;

  return {
    config,
    loading: loading || poolsLoading,
    error,
    poolInfo: bestPool,
  };
}
