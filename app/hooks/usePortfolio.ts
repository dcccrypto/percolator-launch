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
  parsePositionNftAccount,
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
import { computeMarkPnlCollateral } from "@/lib/trading";
import { getAllProgramIds, getNetwork } from "@/lib/config";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getEntryPrice } from "@/lib/entry-price";
import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";

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
  /**
   * True when this position is escrowed inside a Position NFT (v17). Minting an
   * NFT B-3-transfers `portfolio.owner` to the NFT program's escrow PDA, so the
   * owner-scan can't find it — it's recovered via the NFT last_holder scan.
   */
  nftWrapped?: boolean;
}

export type LiquidationSeverity = "safe" | "warning" | "danger";

export function getLiquidationSeverity(distancePct: number): LiquidationSeverity {
  if (distancePct <= 10) return "danger";
  if (distancePct <= 30) return "warning";
  return "safe";
}

/**
 * Map a parsed v17 portfolio into an enriched PortfolioPosition (liq price, PnL,
 * leverage). Shared by the owner-scan path and the NFT-wrapped recovery scan so
 * both surface identical rows. `nftWrapped` flags escrowed positions for the UI.
 */
function buildV17Position(
  portfolio: ReturnType<typeof parsePortfolioV17>,
  oraclePriceE6: bigint,
  maintenanceMarginBps: bigint,
  slabAddrStr: string,
  market: DiscoveredMarket,
  nftWrapped = false,
): PortfolioPosition {
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

  const effectiveEntryPrice = getEntryPrice(slabAddrStr, 0, portfolio.owner.toBase58());
  const liquidationPriceE6 = computeLiqPrice(
    effectiveEntryPrice,
    account.capital,
    account.positionSize,
    maintenanceMarginBps,
  );
  // computeMarkPnl (and the stale account.pnl fallback below, which is in the
  // SAME native scale — see computeMarkPnlCollateral's doc comment) returns
  // PnL in coin-margined native units, not collateral/USD. Convert once via
  // computeMarkPnlCollateral before it's displayed or fed to computePnlPercent
  // — mirrors PositionsDock's pnlNative/pnlTokens split.
  const pnlNative = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
    ? computeMarkPnl(account.positionSize, effectiveEntryPrice, oraclePriceE6)
    : (isSentinelValue(account.pnl) ? 0n : account.pnl);
  const unrealizedPnl = oraclePriceE6 > 0n ? computeMarkPnlCollateral(pnlNative, oraclePriceE6) : 0n;
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

  return {
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
    nftWrapped,
  };
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
        // v17 markets keyed by slab address → oracle price + margin, so the
        // NFT-wrapped recovery scan below can enrich escrowed portfolios using
        // the same market context the owner-scan used.
        const marketMetaBySlab = new Map<
          string,
          { market: DiscoveredMarket; oraclePriceE6: bigint; maintenanceMarginBps: bigint }
        >();
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

              // Remember this v17 market's context so the NFT-wrapped recovery
              // scan below can enrich escrowed portfolios the same way.
              marketMetaBySlab.set(slabAddrStr, { market, oraclePriceE6, maintenanceMarginBps });

              const V17_PORTFOLIO_MAGIC_P = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
              const portfolioResults = await connection.getProgramAccounts(v17ProgramId, {
                filters: [
                  { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_P.toString("base64"), encoding: "base64" } },
                  { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
                  // Mutable owner (SDK PF_OWNER_OFF) is at offset 116, NOT offset 80
                  // (offset 80 is provenanceOwner — IMMUTABLE). MintPositionNft moves
                  // the mutable owner to the escrow PDA on wrap but leaves provenance
                  // pointing at the original wallet, so filtering on 80 would still
                  // match a wrapped (NFT-escrowed) portfolio here — it would render as
                  // a plain owned row whose Close then fails on-chain (owner mismatch),
                  // and it would poison the seenSlabs dedup below so the NFT-recovery
                  // scan skips re-adding it with nftWrapped: true. Mirrors
                  // useUserAccount.ts / useDeposit.ts (commit 3ae16309).
                  { memcmp: { offset: 116, bytes: publicKey!.toBase58() } },
                ],
              });

              for (const { account: portAcct } of portfolioResults) {
                if (cancelled) return;
                const portData = portAcct.data instanceof Buffer ? portAcct.data : Buffer.from(portAcct.data);
                const portfolio = parsePortfolioV17(portData);
                // Defense-in-depth: re-verify the mutable owner actually matches after
                // fetch — memcmp filters are advisory server-side; don't trust them
                // blindly (same re-verify as useUserAccount.ts / useDeposit.ts).
                if (!portfolio.owner.equals(publicKey!)) continue;

                const pos = buildV17Position(
                  portfolio,
                  oraclePriceE6,
                  maintenanceMarginBps,
                  slabAddrStr,
                  market,
                );

                if (pos.liquidationDistancePct <= 30 && pos.account.positionSize !== 0n) {
                  riskCount++;
                }

                allPositions.push(pos);
                pnlSum += isSentinelValue(pos.account.pnl) ? 0n : pos.account.pnl;
                depositSum += pos.account.capital;
                unrealizedPnlSum += pos.unrealizedPnl;
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
                    account.entryPrice > 0n ? account.entryPrice : getEntryPrice(slabAddrStr, idx, account.owner.toBase58());

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
                  // computeMarkPnl (and the account.pnl fallback below, in the
                  // same native scale) returns coin-margined native units, not
                  // collateral/USD — convert via computeMarkPnlCollateral
                  // before display/computePnlPercent (mirrors PositionsDock).
                  const pnlNative = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
                    ? computeMarkPnl(account.positionSize, effectiveEntryPrice, oraclePriceE6)
                    : (isSentinelValue(account.pnl) ? 0n : account.pnl);
                  const unrealizedPnl = oraclePriceE6 > 0n
                    ? computeMarkPnlCollateral(pnlNative, oraclePriceE6)
                    : 0n;

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
          } catch {
            // Skip markets that fail to parse
          }
        }

        // ── NFT-wrapped position recovery (v17) ──────────────────────────────
        // Minting a Position NFT B-3-transfers `portfolio.owner` to the NFT
        // program's escrow PDA, so the owner-scans above (memcmp offset 80 ==
        // wallet) never match a wrapped portfolio — the position vanishes from
        // /portfolio after wrapping. Recover it the only way still possible:
        // scan the NFT program for PositionNfts this wallet still holds
        // (last_holder == wallet, offset 167) and load the escrowed portfolio
        // each one wraps. Best-effort: a failure here must never break the load.
        try {
          const POSITION_NFT_V17_LEN = 199;
          const NFT_LAST_HOLDER_OFF = 167;
          // Dedup guard: markets that already surfaced a (non-wrapped) position.
          const seenSlabs = new Set(allPositions.map((p) => p.slabAddress));
          const nfts = await connection.getProgramAccounts(PERCOLATOR_NFT_PROGRAM_ID, {
            filters: [
              { dataSize: POSITION_NFT_V17_LEN },
              { memcmp: { offset: NFT_LAST_HOLDER_OFF, bytes: pkStr } },
            ],
          });
          for (const nft of nfts) {
            if (cancelled) return;
            try {
              const parsed = parsePositionNftAccount(new Uint8Array(nft.account.data as Buffer));
              const pfInfo = await connection.getAccountInfo(parsed.portfolioAccount);
              if (cancelled) return;
              if (!pfInfo || !pfInfo.data) continue;
              const portfolio = parsePortfolioV17(new Uint8Array(pfInfo.data));
              // Only surface a wrapped position that still has an active leg
              // (a closed-but-unburned NFT wraps a size-0 leg).
              const activeLeg = portfolio.legs.find((l) => l.active);
              if (!activeLeg || activeLeg.basisPosQ === 0n) continue;
              const slabAddrStr = portfolio.marketGroupId?.toBase58();
              if (!slabAddrStr) continue;
              // Skip if this market already produced a position, and only surface
              // markets we actually discovered (so we have oracle/margin context).
              if (seenSlabs.has(slabAddrStr)) continue;
              const meta = marketMetaBySlab.get(slabAddrStr);
              if (!meta) continue;

              const pos = buildV17Position(
                portfolio,
                meta.oraclePriceE6,
                meta.maintenanceMarginBps,
                slabAddrStr,
                meta.market,
                true, // nftWrapped
              );

              if (pos.liquidationDistancePct <= 30 && pos.account.positionSize !== 0n) {
                riskCount++;
              }
              allPositions.push(pos);
              seenSlabs.add(slabAddrStr);
              pnlSum += isSentinelValue(pos.account.pnl) ? 0n : pos.account.pnl;
              depositSum += pos.account.capital;
              unrealizedPnlSum += pos.unrealizedPnl;
            } catch {
              // Resilient per-NFT: skip on any parse / RPC error.
            }
          }
        } catch {
          // NFT scan is best-effort — never break the core portfolio load.
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
