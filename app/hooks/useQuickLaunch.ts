"use client";

import { useEffect, useState } from "react";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { PublicKey } from "@solana/web3.js";
import { useDexPoolSearch, type DexPoolResult } from "./useDexPoolSearch";
import { fetchTokenMeta } from "@/lib/tokenMeta";

export interface QuickLaunchConfig {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Opening price (USD decimal string) from the best detected pool, or `null`
   *  when no live price was found. Never a placeholder — see `adminPrice`. */
  initialPrice: string | null;
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
  /** Detected oracle type for this token */
  oracleType: "pyth" | "hyperp_ema" | "admin";
  /** Pyth feed ID (hex64) if oracleType === "pyth", else null */
  pythFeedId: string | null;
  /**
   * Resolved opening price (USD decimal string), or `null` when no live price
   * could be resolved. NEVER defaults to a placeholder: this value sizes the
   * LP's per-trade cap at creation and can never be changed afterwards, so a
   * fabricated price permanently mis-sizes the market (see
   * `deriveMarketParams` and StepParameters' "Opening Price" block). `null`
   * makes the launch guard in CreateMarketWizard refuse the launch.
   */
  adminPrice: string | null;
  /** PERC-470: DEX pool address for hyperp oracle mode */
  dexPoolAddress: string | null;
  /**
   * True when the /api/oracle/resolve lookup itself FAILED (non-ok response,
   * network error, timeout) — as opposed to succeeding and genuinely finding
   * no feed. Either way `adminPrice` stays null and the launch is blocked;
   * this flag lets the wizard explain WHICH of the two happened.
   */
  oracleResolveFailed: boolean;
}

/**
 * Auto-detects token metadata and best DEX pool, then suggests
 * sensible market parameters based on liquidity.
 * Also resolves oracle type: Pyth (mainnet) vs admin (devnet-only tokens).
 */
export function useQuickLaunch(mint: string | null): QuickLaunchResult {
  const { connection } = useConnectionCompat();
  const { pools, loading: poolsLoading, error: poolsError, blockedReason } = useDexPoolSearch(mint);
  const [config, setConfig] = useState<QuickLaunchConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenMeta, setTokenMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null);

  // Oracle detection state
  const [oracleType, setOracleType] = useState<"pyth" | "hyperp_ema" | "admin">("admin");
  const [pythFeedId, setPythFeedId] = useState<string | null>(null);
  const [adminPrice, setAdminPrice] = useState<string | null>(null);
  const [dexPoolAddress, setDexPoolAddress] = useState<string | null>(null);
  const [oracleResolveFailed, setOracleResolveFailed] = useState(false);

  // Oracle resolution: call /api/oracle/resolve/[mint] after token meta loads.
  // If Pyth feed found → pyth oracle; else → admin oracle with best available price.
  useEffect(() => {
    setOracleType("admin");
    setPythFeedId(null);
    setAdminPrice(null);
    setDexPoolAddress(null);
    setOracleResolveFailed(false);
    if (!mint || mint.length < 32 || !tokenMeta) return;

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`/api/oracle/resolve/${mint}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;
        if (resp.ok) {
          const data = await resp.json();
          // Mint A's response can resolve after a newer mint B request has
          // already started (or landed) — without this second guard, A's
          // stale parsed body would stomp B's fresh oracle-type state and the
          // market gets created with the WRONG oracle config.
          if (cancelled) return;
          setOracleResolveFailed(false);
          if (data.feedId) {
            setOracleType("pyth");
            setPythFeedId(data.feedId);
            setDexPoolAddress(null);
            if (data.price > 0) setAdminPrice(data.price.toFixed(6));
          } else if (data.oracleMode === "hyperp" && data.dexPoolAddress) {
            // PERC-470: Hyperp mode — DEX pool is the oracle
            setOracleType("hyperp_ema");
            setPythFeedId(null);
            setDexPoolAddress(data.dexPoolAddress);
            if (data.price > 0) setAdminPrice(data.price.toFixed(6));
          } else {
            setOracleType("admin");
            setPythFeedId(null);
            setDexPoolAddress(null);
            if (data.price > 0) setAdminPrice(data.price.toFixed(6));
          }
        } else {
          // Non-ok response — fall back to admin oracle, but flag the failure
          // so the wizard can warn: a transient 503 would otherwise silently
          // create a market with a hardcoded $1.00 admin price.
          setOracleType("admin");
          setPythFeedId(null);
          setOracleResolveFailed(true);
        }
      } catch {
        if (!cancelled) {
          setOracleType("admin");
          setPythFeedId(null);
          setOracleResolveFailed(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [mint, tokenMeta]);

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

    // Block tokens with > 12 decimals (u64 overflow risk in on-chain arithmetic)
    if (tokenMeta.decimals > 12) {
      setError(`Token has ${tokenMeta.decimals} decimals — max safe limit is 12. Tokens with excessive decimals cause integer overflow on Solana.`);
      setConfig(null);
      return;
    }

    // The DEX pool lookup failed (network error / non-2xx) rather than
    // genuinely finding zero pools. Don't silently fall through to the
    // "low liquidity" tier defaults for what might be a highly liquid token —
    // surface the error and withhold the suggested config instead.
    if (poolsError) {
      setError(`Could not determine liquidity for this token (pool lookup failed: ${poolsError}). Try again, or set market parameters manually.`);
      setConfig(null);
      return;
    }

    // The token trades, but only on a DEX we withhold from new markets (see
    // BLOCKED_DEX_IDS). Say so explicitly — otherwise this is indistinguishable
    // from "no pools at all" and the launch fails later with a bare
    // "no live price could be resolved".
    if (blockedReason) {
      setError(blockedReason);
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
      // null, never "1.000000": a fabricated opening price permanently
      // mis-sizes the LP's per-trade cap (see QuickLaunchConfig.initialPrice).
      initialPrice: price > 0 ? price.toFixed(6) : null,
      maxLeverage,
      initialMarginBps,
      maintenanceMarginBps,
      tradingFeeBps,
      lpCollateral: "1000",
      liquidityTier: tier,
    });
  }, [tokenMeta, pools, mint, poolsError, blockedReason]);

  const bestPool = pools.length > 0 ? pools[0] : null;

  return {
    config,
    loading: loading || poolsLoading,
    error,
    poolInfo: bestPool,
    oracleType,
    pythFeedId,
    adminPrice,
    dexPoolAddress,
    oracleResolveFailed,
  };
}
