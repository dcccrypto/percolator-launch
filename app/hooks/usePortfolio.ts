"use client";

import { useEffect, useState } from "react";
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
} from "@percolator/sdk";
import { getConfig } from "@/lib/config";

export interface PortfolioPosition {
  slabAddress: string;
  symbol: string | null;
  account: Account;
  idx: number;
  market: DiscoveredMarket;
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
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    if (!publicKey) {
      setPositions([]);
      setTotalPnl(0n);
      setTotalDeposited(0n);
      setTotalValue(0n);
      setTotalUnrealizedPnl(0n);
      setAtRiskCount(0);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const cfg = getConfig();
    const programIds = new Set<string>();
    if (cfg.programId) programIds.add(cfg.programId);
    const byTier = (cfg as any).programsBySlabTier as Record<string, string> | undefined;
    if (byTier) Object.values(byTier).forEach((id) => { if (id) programIds.add(id); });
    const pkStr = publicKey.toBase58();

    async function load() {
      try {
        setLoading(true);
        const marketArrays = await Promise.all(
          [...programIds].map((id) => discoverMarkets(connection, new PublicKey(id)).catch(() => []))
        );
        const markets = marketArrays.flat();
        const allPositions: PortfolioPosition[] = [];
        let pnlSum = 0n;
        let depositSum = 0n;
        let unrealizedPnlSum = 0n;
        let riskCount = 0;

        // Batch fetch all slab accounts using getMultipleAccountsInfo
        const slabAddresses = markets.map((m) => m.slabAddress);
        let slabAccountsInfo: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
        
        try {
          slabAccountsInfo = await connection.getMultipleAccountsInfo(slabAddresses);
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
              oraclePriceE6 = config.lastEffectivePriceE6;
              const params = parseParams(accountInfo.data);
              maintenanceMarginBps = params.maintenanceMarginBps;
            } catch {
              // If config parse fails, use defaults
            }

            for (const { idx, account } of accounts) {
              if (account.kind === AccountKind.User && account.owner.toBase58() === pkStr) {
                // Compute liquidation price
                const liquidationPriceE6 = computeLiqPrice(
                  account.entryPrice,
                  account.capital,
                  account.positionSize,
                  maintenanceMarginBps,
                );

                // Compute unrealized PnL using oracle price
                const unrealizedPnl = oraclePriceE6 > 0n
                  ? computeMarkPnl(account.positionSize, account.entryPrice, oraclePriceE6)
                  : account.pnl;

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

                // Leverage = notional / capital
                const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
                let leverage = 0;
                if (account.capital > 0n && oraclePriceE6 > 0n) {
                  // notional = absPos * price / price (coin-margined) = absPos
                  // For coin-margined: leverage = absPos / capital
                  leverage = Number((absPos * 100n) / account.capital) / 100;
                }

                // Track liquidation risk
                if (liquidationDistancePct <= 30 && account.positionSize !== 0n) {
                  riskCount++;
                }

                allPositions.push({
                  slabAddress: market.slabAddress.toBase58(),
                  symbol: null,
                  account,
                  idx,
                  market,
                  oraclePriceE6,
                  liquidationPriceE6,
                  liquidationDistancePct,
                  unrealizedPnl,
                  pnlPercent,
                  leverage,
                  maintenanceMarginBps,
                });
                pnlSum += account.pnl;
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
            const aSev = getLiquidationSeverity(a.liquidationDistancePct);
            const bSev = getLiquidationSeverity(b.liquidationDistancePct);
            const sevOrder = { danger: 0, warning: 1, safe: 2 };
            if (sevOrder[aSev] !== sevOrder[bSev]) return sevOrder[aSev] - sevOrder[bSev];
            return Number(b.unrealizedPnl - a.unrealizedPnl);
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
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [connection, publicKey, refreshCounter]);

  const refresh = () => setRefreshCounter((c) => c + 1);

  return { positions, totalPnl, totalDeposited, totalValue, totalUnrealizedPnl, atRiskCount, loading, refresh };
}
