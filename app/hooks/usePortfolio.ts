"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import {
  discoverMarketsViaStaticBundle,
  parseAllAccounts,
  parseConfig,
  parseParams,
  parsePortfolioV17,
  parseWrapperConfigV17,
  isV17Account,
  AccountKind,
  computeLiqPrice,
  computeMarkPnl,
  computePnlPercent,
  V17_HEADER_LEN,
  type DiscoveredMarket,
  type Account,
} from "@percolatorct/sdk";
import { isSentinelValue } from "@/lib/health";
import { getAllProgramIds, getNetwork } from "@/lib/config";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getEntryPrice } from "@/lib/entry-price";
import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";

const MAINNET_STATIC_MARKETS = [
  {
    slabAddress: "AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J",
    symbol: "SOL-PERP",
    name: "SOL/USD Perpetual",
  },
];

function getApiBaseUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URL("/api", window.location.origin).toString();
}

async function discoverPortfolioMarkets(
  connection: ReturnType<typeof useConnectionCompat>["connection"],
  programId: PublicKey,
): Promise<DiscoveredMarket[]> {
  const network = getNetwork();
  const apiBaseUrl = getApiBaseUrl();

  if (apiBaseUrl) {
    const viaApi = await discoverMarketsViaProgramDirectory(connection, programId, apiBaseUrl, {
      timeoutMs: 8_000,
    }).catch(() => [] as DiscoveredMarket[]);
    if (viaApi.length > 0) return viaApi;
  }

  if (network === "mainnet") {
    const viaStatic = await discoverMarketsViaStaticBundle(
      connection,
      programId,
      MAINNET_STATIC_MARKETS,
    ).catch(() => [] as DiscoveredMarket[]);
    if (viaStatic.length > 0) return viaStatic;
  }

  return [];
}

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
  /** Risk leverage (position notional / slab account capital) */
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
  /**
   * GH#2414: true when at least one market could not be scanned, so this
   * snapshot is INCOMPLETE. Positions may be missing and every total below
   * (deposited, value, PnL, atRiskCount) may be understated. Callers must not
   * present a partial snapshot as a complete picture of the wallet's exposure.
   */
  isPartial: boolean;
  /** GH#2414: how many markets failed to scan. 0 when isPartial is false. */
  failedMarketCount: number;
  refresh: () => void;
}

/**
 * Fetches all markets and finds positions for the connected wallet.
 * Enriches each position with liquidation price, PnL %, and risk leverage.
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
  // GH#2414: incompleteness must be part of the published snapshot, not a
  // console.error nobody sees.
  const [isPartial, setIsPartial] = useState(false);
  const [failedMarketCount, setFailedMarketCount] = useState(0);
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
      // No wallet is a COMPLETE (empty) picture, not a failed scan — clear any
      // partial flag left over from a previously connected wallet (GH#2414).
      setIsPartial(false);
      setFailedMarketCount(0);
      hasLoadedOnce.current = false;
      return;
    }

    let cancelled = false;
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
          programIds.map((id) => discoverPortfolioMarkets(connection, new PublicKey(id)))
        );
        const markets = marketArrays.flat();
        const allPositions: PortfolioPosition[] = [];
        let pnlSum = 0n;
        let depositSum = 0n;
        let unrealizedPnlSum = 0n;
        let riskCount = 0;
        // GH#2414: every failure below used to be swallowed into an empty
        // result, making an incomplete scan indistinguishable from a wallet
        // with no positions. Count them so the snapshot can declare itself
        // partial instead of silently understating the user's exposure.
        let failedMarkets = 0;

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
          // GH#2414: this is the worst case — the batch slab fetch covers EVERY
          // market, so failing here previously produced an empty portfolio that
          // rendered as "you have no positions".
          console.error("[usePortfolio] Failed to batch fetch slabs:", error);
          slabAccountsInfo = [];
          failedMarkets += markets.length;
        }
        
        // Process each slab to find user accounts
        for (let i = 0; i < markets.length; i++) {
          const market = markets[i];
          const accountInfo = slabAccountsInfo[i];
          
          if (!accountInfo || !accountInfo.data) {
            continue;
          }
          
          try {
            const slabData = accountInfo.data;
            const slabAddrStr = market.slabAddress.toBase58();

            if (isV17Account(slabData)) {
              // ── v17 market path ────────────────────────────────────────────
              // v17 portfolios are standalone program-owned accounts. We scan
              // getProgramAccounts for this user's portfolio on this market.
              // The program that owns the slab is accountInfo.owner.
              const v17ProgramId = accountInfo.owner;
              const slabPk = market.slabAddress; // Already a PublicKey

              // Oracle price: read markEwmaE6 from v17 WrapperConfigV17 (at V17_HEADER_LEN).
              let oraclePriceE6 = 0n;
              let maintenanceMarginBps = 500n;
              try {
                const wCfg = parseWrapperConfigV17(slabData, V17_HEADER_LEN);
                // markEwmaE6 is the last effective price in v17 wrapper config.
                oraclePriceE6 = sanitizePriceE6(wCfg.markEwmaE6);
              } catch {
                // Use defaults if parse fails
              }

              const V17_PORTFOLIO_MAGIC_P = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
              const portfolioResults = await connection.getProgramAccounts(v17ProgramId, {
                filters: [
                  { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_P.toString("base64"), encoding: "base64" } },
                  { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                  { memcmp: { offset: 80, bytes: publicKey!.toBase58() } },
                ],
              });

              for (const { account: portAcct } of portfolioResults) {
                if (cancelled) return;
                const portData = portAcct.data instanceof Buffer ? portAcct.data : Buffer.from(portAcct.data);
                const portfolio = parsePortfolioV17(portData);

                // Map v17 portfolio to the Account shape used by the rest of usePortfolio
                const ZERO_PK = new PublicKey(new Uint8Array(32));
                const activeLeg = portfolio.legs.find((l) => l.active);
                const positionSize = activeLeg ? activeLeg.basisPosQ : 0n;

                const account: Account = {
                  kind: AccountKind.User,
                  accountId: 0n,
                  capital: portfolio.capital,
                  pnl: portfolio.pnl,
                  reservedPnl: portfolio.reservedPnl,
                  warmupStartedAtSlot: 0n,
                  warmupSlopePerStep: 0n,
                  positionSize,
                  entryPrice: 0n,
                  fundingIndex: 0n,
                  matcherProgram: ZERO_PK,
                  matcherContext: ZERO_PK,
                  owner: portfolio.owner,
                  feeCredits: portfolio.feeCredits,
                  lastFeeSlot: portfolio.lastFeeSlot,
                  feesEarnedTotal: 0n,
                  exactReserveCohorts: null,
                  exactCohortCount: null,
                  overflowOlder: null,
                  overflowOlderPresent: null,
                  overflowNewest: null,
                  overflowNewestPresent: null,
                  fSnap: 0n,
                  adlABasis: 0n,
                  adlKSnap: 0n,
                  adlEpochSnap: 0n,
                  schedPresent: null,
                  schedRemainingQ: null,
                  schedAnchorQ: null,
                  schedStartSlot: null,
                  schedHorizon: null,
                  schedReleaseQ: null,
                  pendingPresent: null,
                  pendingRemainingQ: null,
                  pendingHorizon: null,
                  pendingCreatedSlot: null,
                } as Account;

                const effectiveEntryPrice = getEntryPrice(slabAddrStr, 0);
                const liquidationPriceE6 = computeLiqPrice(
                  effectiveEntryPrice,
                  account.capital,
                  account.positionSize,
                  maintenanceMarginBps,
                );
                const unrealizedPnl = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
                  ? computeMarkPnl(account.positionSize, effectiveEntryPrice, oraclePriceE6)
                  : (isSentinelValue(account.pnl) ? 0n : account.pnl);
                const pnlPercent = computePnlPercent(unrealizedPnl, account.capital);

                let liquidationDistancePct = 100;
                if (oraclePriceE6 > 0n && liquidationPriceE6 > 0n && account.positionSize !== 0n) {
                  if (account.positionSize > 0n) {
                    liquidationDistancePct = oraclePriceE6 > liquidationPriceE6
                      ? Number(((oraclePriceE6 - liquidationPriceE6) * 10000n) / oraclePriceE6) / 100
                      : 0;
                  } else {
                    liquidationDistancePct = liquidationPriceE6 > oraclePriceE6
                      ? Number(((liquidationPriceE6 - oraclePriceE6) * 10000n) / liquidationPriceE6) / 100
                      : 0;
                  }
                }

                const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
                let leverage = 0;
                if (account.capital > 0n && oraclePriceE6 > 0n) {
                  leverage = Number((absPos * oraclePriceE6 / 1_000_000n) * 100n / account.capital) / 100;
                }

                if (liquidationDistancePct <= 30 && account.positionSize !== 0n) {
                  riskCount++;
                }

                allPositions.push({
                  slabAddress: slabAddrStr,
                  symbol: null,
                  account,
                  idx: 0,
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
                pnlSum += isSentinelValue(account.pnl) ? 0n : account.pnl;
                depositSum += account.capital;
                unrealizedPnlSum += unrealizedPnl;
              }
            } else {
              // ── v12.x legacy path ──────────────────────────────────────────
              const accounts = parseAllAccounts(slabData);

              // Parse config and params for this market (needed for oracle price + risk params)
              let oraclePriceE6 = 0n;
              let maintenanceMarginBps = 500n; // default 5%
              try {
                const config = parseConfig(slabData);
                // GH#1990: lastEffectivePriceE6 is the raw oracle price (pre-inversion).
                // Apply invert flag so oraclePriceE6 is in the same domain as entryPrice
                // (which is stored post-inversion on-chain). Without this, PnL and
                // liquidation calculations are directionally wrong for inverted markets.
                const rawPriceE6 = config.lastEffectivePriceE6;
                oraclePriceE6 = sanitizePriceE6(applyInvert(rawPriceE6, config.invert));
                const params = parseParams(slabData);
                maintenanceMarginBps = params.maintenanceMarginBps;
              } catch {
                // If config parse fails, use defaults
              }

              for (const { idx, account } of accounts) {
                if (account.kind === AccountKind.User && account.owner.toBase58() === pkStr) {
                  // V12_1: entry_price was removed from on-chain struct. Fall back to
                  // localStorage (saved by TradeForm at trade time) so portfolio PnL
                  // and liq-price compute correctly instead of showing 0/—.
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

                  // Risk leverage = notional / slab account capital.
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
            }
          } catch (error) {
            // GH#2414: a market that fails to scan is NOT a market with no
            // positions. This path covers the v17 getProgramAccounts owner scan,
            // so swallowing it hid real positions while the same positions
            // stayed visible on the market page.
            console.error(
              "[usePortfolio] Market scan failed:",
              market.slabAddress.toBase58(),
              error,
            );
            failedMarkets++;
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
            // Then by PnL — bigint compare to avoid Number() precision loss
            // (positions with PnL > Number.MAX_SAFE_INTEGER would otherwise
            // produce a garbage sign and shuffle on each refresh).
            if (b.unrealizedPnl > a.unrealizedPnl) return 1;
            if (b.unrealizedPnl < a.unrealizedPnl) return -1;
            // Stable tiebreaker: sort by slab address to prevent random reordering
            return a.slabAddress.localeCompare(b.slabAddress);
          });

          setPositions(allPositions);
          setTotalPnl(pnlSum);
          setTotalDeposited(depositSum);
          setTotalValue(depositSum + unrealizedPnlSum);
          setTotalUnrealizedPnl(unrealizedPnlSum);
          setAtRiskCount(riskCount);
          // GH#2414: publish completeness alongside the numbers it qualifies,
          // so no consumer can read the totals without it.
          setIsPartial(failedMarkets > 0);
          setFailedMarketCount(failedMarkets);
        }
      } catch (error) {
        // GH#2414: a throw here means market discovery itself failed, so we
        // know nothing about this wallet. Previously this was ignored and the
        // stale/empty state was left rendering as a completed scan.
        console.error("[usePortfolio] Portfolio load failed:", error);
        if (!cancelled) {
          setIsPartial(true);
          setFailedMarketCount((prev) => (prev > 0 ? prev : 1));
        }
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

  return { positions, totalPnl, totalDeposited, totalValue, totalUnrealizedPnl, atRiskCount, loading, isRefreshing, isPartial, failedMarketCount, refresh };
}
