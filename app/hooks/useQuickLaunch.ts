"use client";

import { useEffect, useState } from "react";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { useDexPoolSearch, type DexPoolResult } from "./useDexPoolSearch";
import { fetchTokenMeta } from "@/lib/tokenMeta";

export interface OracleResolution {
  found: boolean;
  feedId?: string;
  symbol?: string;
  priceUsd?: number;
  source?: "pyth" | null;
}

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
  /** Whether the token has a mainnet Pyth feed */
  isMainnet: boolean;
  /** Resolved oracle type */
  oracleType: "pyth" | "admin";
  /** Pyth feed ID if found */
  pythFeedId?: string;
}

export interface QuickLaunchResult {
  config: QuickLaunchConfig | null;
  loading: boolean;
  error: string | null;
  poolInfo: DexPoolResult | null;
  oracle: OracleResolution | null;
}

/**
 * Auto-detects token metadata and best DEX pool, then suggests
 * sensible market parameters based on liquidity.
 */
export function useQuickLaunch(mint: string | null): QuickLaunchResult {
  const { connection } = useConnectionCompat();
  const { pools, loading: poolsLoading } = useDexPoolSearch(mint);
  const [config, setConfig] = useState<QuickLaunchConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null);
  const [oracle, setOracle] = useState<OracleResolution | null>(null);
  const [oracleLoading, setOracleLoading] = useState(false);

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

  // Resolve oracle (Pyth feed lookup) after token meta is fetched
  useEffect(() => {
    setOracle(null);
    if (!mint || mint.length < 32) return;

    let cancelled = false;
    setOracleLoading(true);

    (async () => {
      try {
        const resp = await fetch(`/api/oracle/resolve/${mint}`);
        if (!resp.ok) {
          if (!cancelled) setOracle({ found: false, source: null });
          return;
        }
        const data = await resp.json();
        if (!cancelled) setOracle(data);
      } catch {
        if (!cancelled) setOracle({ found: false, source: null });
      } finally {
        if (!cancelled) setOracleLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [mint]);

  // Build config when we have both token meta and pools
  useEffect(() => {
    if (!tokenMeta || !mint) {
      setConfig(null);
      return;
    }

    // Block tokens with > 12 decimals (u64 overflow risk in on-chain arithmetic)
    if (tokenMeta.decimals > 12) {
      setError(`Token has ${tokenMeta.decimals} decimals — max safe limit is 12. Tokens with excessive decimals cause integer overflow on Solana.`);
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

    const isMainnet = oracle?.found === true && oracle?.source === "pyth";
    const resolvedOracleType = isMainnet ? "pyth" as const : "admin" as const;
    const oraclePrice = oracle?.priceUsd;
    const effectivePrice = oraclePrice && oraclePrice > 0 ? oraclePrice : (price > 0 ? price : 1);

    setConfig({
      mint,
      name: tokenMeta.name,
      symbol: tokenMeta.symbol,
      decimals: tokenMeta.decimals,
      initialPrice: effectivePrice.toFixed(6),
      maxLeverage,
      initialMarginBps,
      maintenanceMarginBps,
      tradingFeeBps,
      lpCollateral: "1000",
      liquidityTier: tier,
      isMainnet,
      oracleType: resolvedOracleType,
      pythFeedId: oracle?.feedId,
    });
  }, [tokenMeta, pools, mint, oracle]);

  const bestPool = pools.length > 0 ? pools[0] : null;

  return {
    config,
    loading: loading || poolsLoading || oracleLoading,
    error,
    poolInfo: bestPool,
    oracle,
  };
}
