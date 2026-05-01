"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import {
  discoverMarkets,
  fetchSlab,
  parseAllAccounts,
  parseConfig,
  parseParams,
  parseEngine,
  AccountKind,
  computeLiqPrice,
  computeMarkPnl,
  computePnlPercent,
  type DiscoveredMarket,
  type Account,
  type RiskParams,
} from "@percolatorct/sdk";
import { isSentinelValue } from "@/lib/health";
import { getConfig, getAllProgramIds } from "@/lib/config";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getEntryPrice } from "@/lib/entry-price";

export interface PortfolioPosition {
  slabAddress: string;
  symbol: string | null;
  account: Account;
  idx: number;
  market: DiscoveredMarket;
  /**
   * Effective entry price in e6 format.
   * V12_1 removed entry_price from the on-chain struct; falls back to
   * localStorage (saved at trade time) when account.entryPrice is 0.
   */
  effectiveEntryPrice: bigint;
  /** Last effective oracle price in e6 format */
  oraclePriceE6: bigint;
  /** Liquidation price in e6 format */
  liquidationPriceE6: bigint;
  /** Distance to liquidation as a percentage (0 = at liq, 100 = far from liq) */
  liquidationDistancePct: number;
  /** Unrealized PnL (mark-to-market using oracle) */
  unrealizedPnl: bigint;
  /** PnL as percentage of capital */
  pnlPercent: number;
  /** Effective leverage (position notional / capital) */
  leverage: number;
  /** Maintenance margin bps for this market */
  maintenanceMarginBps: bigint;
}

export type LiquidationSeverity = "safe" | "warning" | "danger";

export function getLiquidationSeverity(distancePct: number): LiquidationSeverity {
  if (distancePct <= 10) return "danger";
  if (distancePct <= 30) return "warning";
  return "safe";
}

export interface PortfolioData {
  positions: PortfolioPosition[];
  totalPnl: bigint;
  totalDeposited: bigint;
  /** Total portfolio value (capital + unrealized PnL) */
  totalValue: bigint;
  /** Total unrealized PnL across all positions */
  totalUnrealizedPnl: bigint;
  /** Number of positions at liquidation risk */
  atRiskCount: number;
  loading: boolean;
  /** True only during background refreshes (not initial load) */
  isRefreshing: boolean;
  refresh: () => void;
}

/**
 * Fetches all markets and finds positions for the connected wallet.
 * Enriches each position with liquidation price, PnL %, and leverage.
 */
export function usePortfolio(): PortfolioData {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [totalPnl, setTotalPnl] = useState<bigint>(0n);
  const [totalDeposited, setTotalDeposited] = useState<bigint>(0n);
  const [totalValue, setTotalValue] = useState<bigint>(0n);
  const [totalUnrealizedPnl, setTotalUnrealizedPnl] = useState<bigint>(0n);
  const [atRiskCount, setAtRiskCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedOnce = useRef(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Reset initial-load lifecycle when wallet identity changes (CodeRabbit fix)
  const prevPublicKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const pkStr = publicKey?.toBase58() ?? null;
    if (pkStr !== prevPublicKeyRef.current) {
      prevPublicKeyRef.current = pkStr;
      hasLoadedOnce.current = false;
      setIsRefreshing(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (!publicKey) {
      setPositions([]);
      setTotalPnl(0n);
      setTotalDeposited(0n);
      setTotalValue(0n);
      setTotalUnrealizedPnl(0n);
      setAtRiskCount(0);
      setLoading(false);
      setIsRefreshing(false);
      hasLoadedOnce.current = false;
      return;
    }

    let cancelled = false;
    const cfg = getConfig();
    const programIds = getAllProgramIds();
    const pkStr = publicKey.toBase58();

    async function load() {
      try {
        if (hasLoadedOnce.current) {
          setIsRefreshing(true);
        } else {
          setLoading(true);
        }
        const marketArrays = await Promise.all(
          programIds.map((id) => discoverMarkets(connection, new PublicKey(id)).catch(() => []))
        );
        const markets = marketArrays.flat();
        const allPositions: PortfolioPosition[] = [];
        let pnlSum = 0n;
        let depositSum = 0n;
        let unrealizedPnlSum = 0n;
        let riskCount = 0;

        // Batch fetch all slab accounts using getMultipleAccountsInfo
        // RPC limit is 100 accounts per call, so chunk into batches
        const slabAddresses = markets.map((m) => m.slabAddress);
        let slabAccountsInfo: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
        
        try {
          const BATCH_SIZE = 100;
          const chunks: PublicKey[][] = [];
          for (let i = 0; i < slabAddresses.length; i += BATCH_SIZE) {
            chunks.push(slabAddresses.slice(i, i + BATCH_SIZE));
          }
          const results = await Promise.all(
            chunks.map((chunk) => connection.getMultipleAccountsInfo(chunk))
          );
          slabAccountsInfo = results.flat();
        } catch (error) {
          console.error("[usePortfolio] Failed to batch fetch slabs:", error);
          slabAccountsInfo = [];
        }
        
        // Process each slab to find user accounts
        for (let i = 0; i < markets.length; i++) {
          const market = markets[i];
          const accountInfo = slabAccountsInfo[i];
          
          if (!accountInfo || !accountInfo.data) {
            continue;
          }
          
          try {
            const accounts = parseAllAccounts(accountInfo.data);
            
            // Parse config and params for this market (needed for oracle price + risk params)
            let oraclePriceE6 = 0n;
            let maintenanceMarginBps = 500n; // default 5%
            try {
              const config = parseConfig(accountInfo.data);
              // GH#1990: lastEffectivePriceE6 is the raw oracle price (pre-inversion).
              // Apply invert flag so oraclePriceE6 is in the same domain as entryPrice
              // (which is stored post-inversion on-chain). Without this, PnL and
              // liquidation calculations are directionally wrong for inverted markets.
              const rawPriceE6 = config.lastEffectivePriceE6;
              oraclePriceE6 = sanitizePriceE6(applyInvert(rawPriceE6, config.invert));
              const params = parseParams(accountInfo.data);
              maintenanceMarginBps = params.maintenanceMarginBps;
            } catch {
              // If config parse fails, use defaults
            }

            for (const { idx, account } of accounts) {
              if (account.kind === AccountKind.User && account.owner.toBase58() === pkStr) {
                // V12_1: entry_price was removed from on-chain struct. Fall back to
                // localStorage (saved by TradeForm at trade time) so portfolio PnL
                // and liq-price compute correctly instead of showing 0/—.
                const slabAddrStr = market.slabAddress.toBase58();
                const effectiveEntryPrice =
                  account.entryPrice > 0n ? account.entryPrice : getEntryPrice(slabAddrStr, idx);

                // Compute liquidation price
                const liquidationPriceE6 = computeLiqPrice(
                  effectiveEntryPrice,
                  account.capital,
                  account.positionSize,
                  maintenanceMarginBps,
                );

                // Compute unrealized PnL using oracle price.
                // GH#1331: account.pnl can be u64::MAX sentinel for uninitialized/flat
                // positions. Guard it with isSentinelValue to prevent billion-dollar
                // phantom PnL on the dashboard when oracle price is unavailable.
                const unrealizedPnl = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
                  ? computeMarkPnl(account.positionSize, effectiveEntryPrice, oraclePriceE6)
                  : (isSentinelValue(account.pnl) ? 0n : account.pnl);

                // PnL percentage
                const pnlPercent = computePnlPercent(unrealizedPnl, account.capital);

                // Liquidation distance percentage
                let liquidationDistancePct = 100;
                if (oraclePriceE6 > 0n && liquidationPriceE6 > 0n && account.positionSize !== 0n) {
                  if (account.positionSize > 0n) {
                    // Long: liq price is below oracle
                    liquidationDistancePct = oraclePriceE6 > liquidationPriceE6
                      ? Number(((oraclePriceE6 - liquidationPriceE6) * 10000n) / oraclePriceE6) / 100
                      : 0;
                  } else {
                    // Short: liq price is above oracle
                    liquidationDistancePct = liquidationPriceE6 > oraclePriceE6
                      ? Number(((liquidationPriceE6 - oraclePriceE6) * 10000n) / liquidationPriceE6) / 100
                      : 0;
                  }
                }

                // Leverage = notional / capital = (contracts * price) / capital
                const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
                let leverage = 0;
                if (account.capital > 0n && oraclePriceE6 > 0n) {
                  // notional_usd = contracts * price; leverage = notional_usd / capital
                  leverage = Number((absPos * oraclePriceE6 / 1_000_000n) * 100n / account.capital) / 100;
                }

                // Track liquidation risk
                if (liquidationDistancePct <= 30 && account.positionSize !== 0n) {
                  riskCount++;
                }

                allPositions.push({
                  slabAddress: slabAddrStr,
                  symbol: null,
                  account,
                  idx,
                  market,
                  effectiveEntryPrice,
                  oraclePriceE6,
                  liquidationPriceE6,
                  liquidationDistancePct,
                  unrealizedPnl,
                  pnlPercent,
                  leverage,
                  maintenanceMarginBps,
                });
                // Guard account.pnl against u64::MAX sentinel values before accumulating.
                // Uninitialized / flat positions store u64::MAX as a sentinel — summing them
                // raw produces septillion-dollar phantom totals (GH#1352 regression).
                pnlSum += isSentinelValue(account.pnl) ? 0n : account.pnl;
                depositSum += account.capital;
                unrealizedPnlSum += unrealizedPnl;
              }
            }
          } catch {
            // Skip markets that fail to parse
          }
        }

        if (!cancelled) {
          // Sort: at-risk positions first, then by PnL
          allPositions.sort((a, b) => {
            // Active positions (has size) before flat/empty
            const aActive = a.account.positionSize !== 0n ? 0 : 1;
            const bActive = b.account.positionSize !== 0n ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            // Then by liquidation severity
            const aSev = getLiquidationSeverity(a.liquidationDistancePct);
            const bSev = getLiquidationSeverity(b.liquidationDistancePct);
            const sevOrder = { danger: 0, warning: 1, safe: 2 };
            if (sevOrder[aSev] !== sevOrder[bSev]) return sevOrder[aSev] - sevOrder[bSev];
            // Then by PnL
            const pnlDiff = Number(b.unrealizedPnl - a.unrealizedPnl);
            if (pnlDiff !== 0) return pnlDiff;
            // Stable tiebreaker: sort by slab address to prevent random reordering
            return a.slabAddress.localeCompare(b.slabAddress);
          });

          setPositions(allPositions);
          setTotalPnl(pnlSum);
          setTotalDeposited(depositSum);
          setTotalValue(depositSum + unrealizedPnlSum);
          setTotalUnrealizedPnl(unrealizedPnlSum);
          setAtRiskCount(riskCount);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setLoading(false);
          setIsRefreshing(false);
          hasLoadedOnce.current = true;
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [connection, publicKey, refreshCounter]);

  const refresh = () => setRefreshCounter((c) => c + 1);

  // Auto-refresh when tab becomes visible (e.g., after closing position on trade page)
  // and every 30s while visible
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setRefreshCounter((c) => c + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        setRefreshCounter((c) => c + 1);
      }
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, []);

  return { positions, totalPnl, totalDeposited, totalValue, totalUnrealizedPnl, atRiskCount, loading, isRefreshing, refresh };
}
