"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { computeLivePositionPnl } from "@/lib/trading";
import { SlabProvider } from "@/components/providers/SlabProvider";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";
import { clearEntryPrice } from "@/lib/entry-price";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePortfolio, getLiquidationSeverity, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useLiveSlabPrices } from "@/hooks/useLiveSlabPrices";
import { useLpPositions } from "@/hooks/useLpPositions";
import { AtRiskBanner } from "@/components/portfolio/AtRiskBanner";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import dynamic from "next/dynamic";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlowButton } from "@/components/ui/GlowButton";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { PublicKey } from "@solana/web3.js";
import { isMockMode } from "@/lib/mock-mode";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";
import { useTraderStats } from "@/hooks/useTraderStats";
import { formatLeverage, RISK_LEVERAGE_LABEL, RISK_LEVERAGE_TITLE } from "@/lib/leverage-display";

const ConnectButton = dynamic(
  () => import("@/components/wallet/ConnectButton").then((m) => m.ConnectButton),
  { ssr: false }
);

// PERF PLAN #4: below-the-fold sections lazy-loaded exactly like
// app/app/dashboard/page.tsx's widgets — ssr:false + a fixed-height
// skeleton (no CLS when the real component swaps in).
const ActivitySection = dynamic(
  () => import("@/components/portfolio/ActivitySection").then((m) => m.ActivitySection),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-2">
        <div className="h-[72px] border border-[var(--border)] bg-[var(--panel-bg)] p-3.5">
          <div className="grid h-full grid-cols-2 gap-4 sm:grid-cols-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-1.5">
                <ShimmerSkeleton className="h-2.5 w-16" />
                <ShimmerSkeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
            <ShimmerSkeleton className="h-4 w-16" />
            <ShimmerSkeleton className="h-4 w-12 rounded" />
            <ShimmerSkeleton className="h-4 w-20" />
            <ShimmerSkeleton className="h-4 w-20" />
            <ShimmerSkeleton className="h-4 w-16" />
            <ShimmerSkeleton className="h-4 w-24 ml-auto" />
          </div>
        ))}
      </div>
    ),
  },
);

const LpPositionsPanel = dynamic(
  () => import("@/components/portfolio/LpPositionsPanel").then((m) => m.LpPositionsPanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-[140px] border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <ShimmerSkeleton className="mb-4 h-4 w-32" />
        <div className="space-y-2">
          <ShimmerSkeleton className="h-8 w-full" />
          <ShimmerSkeleton className="h-8 w-full" />
        </div>
      </div>
    ),
  },
);

function formatPnl(pnl: bigint | undefined | null, decimals = 6): string {
  const safePnl = pnl ?? 0n;
  const isNeg = safePnl < 0n;
  const abs = isNeg ? -safePnl : safePnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

function formatPnlPct(pct: number | null | undefined): string {
  if (pct == null) return "0.00%";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** On-demand close flow. Mounted (with its own SlabProvider — useClosePosition
 *  needs slab context) only while the modal is open, so the portfolio page
 *  never pays N providers' RPC cost for rows the user isn't closing. */
function PortfolioCloseFlow({
  pos,
  markE6,
  priceUsd,
  baseSymbol,
  collateralSymbol,
  decimals,
  onDone,
}: {
  pos: PortfolioPosition;
  markE6: bigint;
  priceUsd: number | null;
  baseSymbol: string;
  collateralSymbol: string;
  decimals: number;
  onDone: (closed: boolean) => void;
}) {
  const { closePosition, loading, error, prewarmClose } = useClosePosition(pos.slabAddress);
  // This flow mounts only when the close modal opens, so mount === modal-open:
  // prewarm the fresh position read + tx caches. Without this, /portfolio was
  // the ONE close path that never prewarmed (the dock and the cross-market list
  // both do), so it consumed whatever the shared read cache happened to hold.
  useEffect(() => { prewarmClose(); }, [prewarmClose]);
  // Reviewer blocker fix: PortfolioCloseFlow previously dropped `error` from
  // useClosePosition, so a failed close just silently re-enabled the modal
  // with no feedback. Also mirror the trade-page's engine-staleness guard
  // (PositionPanel.tsx) — this component always mounts inside a per-slab
  // SlabProvider (see the call site below), so useEngineFreshness() has the
  // context it needs.
  const { engineStale } = useEngineFreshness();
  const posSize = pos.account?.positionSize ?? 0n;
  return (
    <ClosePositionModal
      positionSize={posSize}
      entryPrice={pos.effectiveEntryPrice}
      currentPrice={markE6}
      capital={pos.account?.capital ?? 0n}
      symbol={baseSymbol}
      collateralSymbol={collateralSymbol}
      decimals={decimals}
      priceUsd={priceUsd}
      isLong={posSize > 0n}
      loading={loading}
      error={error}
      oracleStale={engineStale}
      onConfirm={async (percent) => {
        try {
          await closePosition(percent);
          if (percent === 100) {
            clearEntryPrice(pos.slabAddress, pos.idx, pos.account?.owner?.toBase58?.() ?? "");
          }
          onDone(true);
        } catch {
          /* keep the modal open; the tx error is logged by the hook */
        }
      }}
      onCancel={() => onDone(false)}
    />
  );
}

/** One open-position card. A component (not inline map body) because each row
 *  needs hooks: a live price-store subscription so PnL / mark / liq distance
 *  tick in real time (previously frozen at the 30s portfolio poll), and
 *  close-modal state for the in-place Close button. */
function PositionCard({
  pos,
  label,
  baseSymbol,
  collateralSymbol,
  decimals,
  onRefresh,
}: {
  pos: PortfolioPosition;
  label: string;
  baseSymbol: string;
  collateralSymbol: string;
  decimals: number;
  onRefresh: () => void;
}) {
  const [showClose, setShowClose] = useState(false);

  // Live mark from the shared WS price store (same feed as the trade page);
  // falls back to the portfolio poll's oracle price until the first tick.
  const subscribe = useCallback((cb: () => void) => subscribeSlab(pos.slabAddress, cb), [pos.slabAddress]);
  const getSnap = useCallback(() => getSnapshot(pos.slabAddress).priceE6, [pos.slabAddress]);
  const livePriceE6 = useSyncExternalStore(subscribe, getSnap, () => null);

  const posSize = pos.account?.positionSize ?? 0n;
  const posCapital = pos.account?.capital ?? 0n;
  const posEntry = pos.effectiveEntryPrice;
  const side = posSize > 0n ? "Long" : posSize < 0n ? "Short" : "Flat";
  const sizeAbs = posSize < 0n ? -posSize : posSize;
  const { liquidationPriceE6, leverage } = pos;
  const hasPosition = posSize !== 0n;

  const markE6 = livePriceE6 != null && livePriceE6 > 0n ? livePriceE6 : pos.oraclePriceE6;
  // Live PnL/ROE: EXACTLY usePortfolio's corrected math with the live mark
  // substituted — see computeLivePositionPnl's doc comment (lib/trading.ts)
  // for the coin-margined-native → collateral conversion + ROE-vs-initial-
  // margin chain. Shared verbatim with PositionsBar's PositionChip and the
  // portfolio hero's live totals below.
  const { pnl: pnlTokens, pnlPercent: pnlPct } = computeLivePositionPnl(
    posSize,
    posEntry,
    markE6,
    pos.initialMarginBps,
    posCapital,
    pos.unrealizedPnl,
    pos.pnlPercent,
  );
  const liquidationDistancePct =
    hasPosition && liquidationPriceE6 > 0n && markE6 > 0n
      ? Math.max(0, Math.min(100, (Math.abs(Number(markE6) - Number(liquidationPriceE6)) / Number(markE6)) * 100))
      : pos.liquidationDistancePct;
  const pnlPositive = pnlTokens >= 0n;
  const severity = getLiquidationSeverity(liquidationDistancePct);
  const livePriceUsd = getSnapshot(pos.slabAddress).priceUsd ?? (markE6 > 0n ? Number(markE6) / 1e6 : null);

  return (
    <>
      <Link
        href={`/trade/${pos.slabAddress}`}
        className={[
          "block border bg-[var(--panel-bg)] transition-all duration-200 hover:bg-[var(--bg-elevated)]",
          severity === "danger" && hasPosition
            ? "border-[var(--short)]/40 hover:border-[var(--short)]/60"
            : severity === "warning" && hasPosition
            ? "border-[var(--warning)]/30 hover:border-[var(--warning)]/50"
            : "border-[var(--border)] hover:border-[var(--accent)]/30",
        ].join(" ")}
      >
        {/* Liquidation warning banner */}
        {severity === "danger" && hasPosition && (
          <div className="flex items-center gap-2 border-b border-[var(--short)]/20 bg-[var(--short)]/5 px-4 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--short)]">
              ⚠ Liquidation Risk — {liquidationDistancePct.toFixed(1)}% away
            </span>
          </div>
        )}
        {severity === "warning" && hasPosition && (
          <div className="flex items-center gap-2 border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)]">
              ⚡ Approaching Liquidation — {liquidationDistancePct.toFixed(1)}% away
            </span>
          </div>
        )}

        <div className="p-4">
          {/* Row 1: Market name, side, PnL, Close */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {label}
              </span>
              <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                side === "Long"
                  ? "bg-[var(--long)]/10 text-[var(--long)]"
                  : side === "Short"
                  ? "bg-[var(--short)]/10 text-[var(--short)]"
                  : "bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
              }`}>
                {side.toUpperCase()}
              </span>
              {leverage > 0 && (
                <span
                  className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]"
                  title={RISK_LEVERAGE_TITLE}
                >
                  Risk {formatLeverage(leverage)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <span
                  className={`text-sm font-bold ${pnlPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {formatPnl(pnlTokens, decimals)}
                </span>
                <span
                  className={`ml-2 text-[10px] font-medium ${pnlPositive ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                >
                  {formatPnlPct(pnlPct)}
                </span>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  // Card is a Link — keep the click from navigating.
                  e.preventDefault();
                  e.stopPropagation();
                  setShowClose(true);
                }}
                className="shrink-0 rounded-none border border-[var(--short)]/30 px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:border-[var(--short)]/60 hover:bg-[var(--short)]/10"
              >
                Close
              </button>
            </div>
          </div>

          {/* Row 2: Details grid */}
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-6">
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Size</p>
              <p className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {formatTokenAmount(sizeAbs, decimals)}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Entry</p>
              <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {formatUsdPriceE6(posEntry)}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Mark Price</p>
              <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {markE6 > 0n ? formatUsdPriceE6(markE6) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Capital</p>
              <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {formatTokenAmount(posCapital, decimals)}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]" title={RISK_LEVERAGE_TITLE}>
                {RISK_LEVERAGE_LABEL}
              </p>
              <p className="text-[12px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                {leverage > 0 ? formatLeverage(leverage) : "—"}
              </p>
            </div>
            <div>
              <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">Liq. Price</p>
              <div className="flex items-center gap-1.5">
                {hasPosition && (
                  <span
                    className={`inline-block h-1.5 w-1.5 rounded-full ${
                      severity === "danger"
                        ? "bg-[var(--short)] shadow-[0_0_6px_var(--short)]"
                        : severity === "warning"
                        ? "bg-[var(--warning)] shadow-[0_0_6px_var(--warning)]"
                        : "bg-[var(--long)]"
                    }`}
                  />
                )}
                <p
                  className={`text-[12px] ${
                    severity === "danger" && hasPosition
                      ? "font-semibold text-[var(--short)]"
                      : severity === "warning" && hasPosition
                      ? "text-[var(--warning)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {hasPosition && liquidationPriceE6 > 0n
                    ? formatUsdPriceE6(liquidationPriceE6)
                    : "—"}
                </p>
              </div>
            </div>
          </div>

          {/* Liquidation distance bar */}
          {hasPosition && liquidationDistancePct < 100 && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-[9px] text-[var(--text)]">
                <span>Liquidation Distance</span>
                <span className={
                  severity === "danger"
                    ? "font-bold text-[var(--short)]"
                    : severity === "warning"
                    ? "font-bold text-[var(--warning)]"
                    : "text-[var(--text-secondary)]"
                }>
                  {liquidationDistancePct.toFixed(1)}%
                </span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--border)]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(liquidationDistancePct, 100)}%`,
                    backgroundColor:
                      severity === "danger"
                        ? "var(--short)"
                        : severity === "warning"
                        ? "var(--warning)"
                        : "var(--long)",
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </Link>

      {/* Close flow — provider mounts only while the modal is open */}
      {showClose && (
        <SlabProvider slabAddress={pos.slabAddress}>
          <PortfolioCloseFlow
            pos={pos}
            markE6={markE6}
            priceUsd={livePriceUsd}
            baseSymbol={baseSymbol}
            collateralSymbol={collateralSymbol}
            decimals={decimals}
            onDone={(closed) => {
              setShowClose(false);
              if (closed) onRefresh();
            }}
          />
        </SlabProvider>
      )}
    </>
  );
}

export default function PortfolioPage() {
  useEffect(() => { document.title = "Portfolio — Percolator"; }, []);
  const { connected: walletConnected, publicKey: walletPublicKey } = useWalletCompat();
  const mockMode = isMockMode();
  const connected = walletConnected || mockMode;
  const portfolio = usePortfolio();

  // In mock mode, use synthetic positions
  const mockPositions = mockMode && !walletConnected ? getMockPortfolioPositions() : null;
  const positions: PortfolioPosition[] = mockPositions ?? portfolio.positions ?? [];
  const atRiskCount = portfolio.atRiskCount ?? 0;
  const loading = mockPositions ? false : portfolio.loading;
  const refresh = portfolio.refresh;

  // LP positions (insurance fund deposits)
  const lpPositions = useLpPositions();
  const isRefreshing = portfolio.isRefreshing || lpPositions.isRefreshing;

  // PERC-481: Aggregate trade statistics
  const traderStats = useTraderStats(walletPublicKey?.toBase58() ?? null);

  // Auto-refresh handled by usePortfolio hook (30s interval + visibility change)

  // Resolve collateral mint addresses to token symbols and decimals. v17 markets
  // return an empty `market.config` from the SDK (real value in
  // `market.configV17.collateralMint`) — use the pre-resolved `pos.collateralMint`
  // (set by usePortfolio) instead of touching `pos.market.config.collateralMint`
  // directly, which is undefined for v17 markets and crashes `.toBase58()`.
  const collateralMints = useMemo(() => positions.map((pos) => pos.collateralMint), [positions]);
  const tokenMetaMap = useMultiTokenMeta(collateralMints);

  // Helper: get collateral decimals for a position from token metadata
  const getDecimals = (pos: typeof positions[number]) =>
    tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6;

  // Compute USD-normalized totals. Collateral across every market is sim-USDC
  // (see PLAYGROUND.md) — `capital` is already collateral-scale dollars, so it
  // only needs the decimals divisor, NOT an oracle-price multiplier (the oracle
  // price prices the position's underlying asset, e.g. SOL, not the collateral).
  // Formula: depositedUsd = rawCapital / 10^decimals
  // Matches PositionsDock's pnlUsdRaw convention (divide by decimals only) and
  // this hook's own usePortfolio totals (which never multiply capital by price).
  // Filter out empty/closed accounts (FLAT with zero capital) — they clutter the list
  const activePositions = positions.filter(
    (pos) => pos.account.positionSize !== 0n || pos.account.capital > 0n
  );

  // Split real trades from idle deposits. A funded-but-flat account is the
  // user's parked collateral, not a position — rendering both identically
  // (and counting deposits in the POSITIONS stat) read as bogus data.
  const openPositions = activePositions.filter((pos) => (pos.account?.positionSize ?? 0n) !== 0n);
  const idleDeposits = activePositions.filter((pos) => (pos.account?.positionSize ?? 0n) === 0n);

  // Market symbol/name per slab — the row label used to show the COLLATERAL
  // token's symbol, which is the same sim-USDC mint (with no token-list
  // metadata → raw address) for every playground market: every row read
  // "DJ54…N8eC/USD" with no way to tell markets apart.
  const { statsMap } = useAllMarketStats();
  // Prefer the symbol usePortfolio itself resolved (upstream P1 fix: API
  // directory + curated static fallback), then the stats map, then a slab stub.
  const marketLabel = (pos: { slabAddress: string; symbol: string | null }): string => {
    const sym = pos.symbol ?? statsMap.get(pos.slabAddress)?.symbol;
    return sym ? `${sym}/USD` : `${pos.slabAddress.slice(0, 8)}…`;
  };

  // GH#1808: Only block on tokenMetas if positions are still loading too. If positions have
  // loaded (loading=false) but tokenMetas haven't resolved, the fetch likely failed silently —
  // unblock the UI instead of leaving it stuck in infinite skeleton state.
  const tokenMetasLoading = collateralMints.length > 0 && tokenMetaMap.size === 0 && loading;

  const computeUsdTotals = () => {
    let depositedUsd = 0;
    let unrealizedPnlUsd = 0;
    for (const pos of activePositions) {
      const decimals = getDecimals(pos);
      const divisor = 10 ** decimals;
      const capital = Number(pos.account.capital ?? 0n) / divisor;
      depositedUsd += capital;
      // pos.unrealizedPnl is already collateral-scale (usePortfolio.ts converts
      // the SDK's native computeMarkPnl output via computeMarkPnlCollateral) —
      // divide by decimals only, same as PositionsDock's pnlUsdRaw and raw
      // capital above (collateral is sim-USDC dollars, no price factor).
      unrealizedPnlUsd += Number(pos.unrealizedPnl) / divisor;
    }
    return { depositedUsd, unrealizedPnlUsd, valueUsd: depositedUsd + unrealizedPnlUsd };
  };
  // Don't compute USD totals until token metadata (decimals) has loaded —
  // using the default 6 decimals for a 9-decimal token inflates values 1000x
  const usdTotals = activePositions.length > 0 && !tokenMetasLoading
    ? computeUsdTotals()
    : { depositedUsd: 0, unrealizedPnlUsd: 0, valueUsd: 0 };

  // PERF PLAN #3: the hero tiles (Portfolio Value / Unrealized PnL) tick
  // LIVE off the shared WS price store, instead of only refreshing on
  // usePortfolio's 30s poll like `usdTotals` above (which the cards below
  // already escape via PositionCard's own per-row live subscription).
  // `useLiveSlabPrices` batches every open position's slab into ONE
  // subscribing effect (see its own doc comment) rather than mounting N
  // useSyncExternalStore instances just for this roll-up.
  const livePrices = useLiveSlabPrices(openPositions.map((pos) => pos.slabAddress));
  const liveUsdTotals = activePositions.length > 0 && !tokenMetasLoading
    ? (() => {
        let unrealizedPnlUsd = 0;
        for (const pos of activePositions) {
          const decimals = getDecimals(pos);
          const divisor = 10 ** decimals;
          const posSize = pos.account?.positionSize ?? 0n;
          const liveE6 = livePrices.get(pos.slabAddress);
          const markE6 = liveE6 != null && liveE6 > 0n ? liveE6 : pos.oraclePriceE6;
          // Same live-mark chain as PositionCard/PositionChip (see
          // computeLivePositionPnl's doc comment) — flat/idle positions
          // (posSize === 0n) fall straight through to `pos.unrealizedPnl`
          // (always 0 for a flat account), so this sum is safe over
          // `activePositions` (open + idle), not just `openPositions`.
          const { pnl } = computeLivePositionPnl(
            posSize,
            pos.effectiveEntryPrice,
            markE6,
            pos.initialMarginBps,
            pos.account?.capital ?? 0n,
            pos.unrealizedPnl,
            pos.pnlPercent,
          );
          unrealizedPnlUsd += Number(pnl) / divisor;
        }
        // Deposited total isn't price-dependent — reuse usdTotals' value
        // rather than re-summing capital a second time.
        return { unrealizedPnlUsd, valueUsd: usdTotals.depositedUsd + unrealizedPnlUsd };
      })()
    : { unrealizedPnlUsd: 0, valueUsd: 0 };

  // Idle (parked, non-position) collateral value — its own Tier-2 tile now
  // that "Positions" no longer conflates open positions with idle deposits.
  const idleDepositsUsd = !tokenMetasLoading
    ? idleDeposits.reduce((sum, pos) => sum + Number(pos.account?.capital ?? 0n) / (10 ** getDecimals(pos)), 0)
    : 0;

  if (!connected) {
    return (
      <div className="min-h-[calc(100dvh-48px)] relative">
        <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
          <div className="relative mx-auto max-w-4xl px-4 py-10">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // portfolio
          </div>
          <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
            <span className="font-normal text-[var(--text)]">Your </span>Positions
          </h1>
          <p className="mt-2 mb-8 text-[13px] text-[var(--text-secondary)]">View all your positions across markets</p>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
            <p className="mb-4 text-[13px] text-[var(--text-secondary)]">Connect your wallet to view positions</p>
            <ConnectButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <ScrollReveal>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // portfolio
              </div>
              <h1 className="text-xl font-medium tracking-[-0.01em] text-[var(--text)] sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                <span className="font-normal text-[var(--text)]">Your </span>Positions
              </h1>
              <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
                All positions across Percolator markets
                {atRiskCount > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-sm bg-[var(--short)]/10 px-2 py-0.5 text-[10px] font-bold text-[var(--short)]">
                    ⚠ {atRiskCount} at risk
                  </span>
                )}
              </p>
            </div>
            {refresh && (
              <button
                onClick={() => { refresh(); lpPositions.refresh(); }}
                disabled={loading || lpPositions.loading || isRefreshing}
                className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-2 text-xs text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)] disabled:opacity-40"
              >
                Refresh
              </button>
            )}
          </div>
        </ScrollReveal>

        {/* At-risk strip — zero height unless a position is within the
            liquidation warning distance (see getLiquidationSeverity). */}
        <AtRiskBanner positions={openPositions} />

        {/* Tier 1 hero: Portfolio Value (live) + live Unrealized PnL beneath. */}
        <ScrollReveal stagger={0.08}>
          <div className="mb-2 border border-[var(--border)] bg-[var(--panel-bg)] p-6 transition-colors duration-200 hover:bg-[var(--bg-elevated)] sm:p-8">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">Portfolio Value</p>
            <p
              className={`text-3xl font-bold tabular-nums sm:text-4xl ${!walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]"}`}
              style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
            >
              {!walletConnected
                ? "\u2014"
                : (loading || tokenMetasLoading)
                  ? "\u2026"
                  : `$${liveUsdTotals.valueUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </p>
            {walletConnected && !loading && !tokenMetasLoading && (
              <div className="mt-3 flex items-baseline gap-2">
                <span
                  className={`text-sm font-bold sm:text-base ${liveUsdTotals.unrealizedPnlUsd >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}`}
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {liveUsdTotals.unrealizedPnlUsd >= 0 ? "+" : ""}
                  ${Math.abs(liveUsdTotals.unrealizedPnlUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span
                  className={`text-xs font-medium ${liveUsdTotals.unrealizedPnlUsd >= 0 ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
                >
                  {formatPnlPct(usdTotals.depositedUsd > 0 ? (liveUsdTotals.unrealizedPnlUsd / usdTotals.depositedUsd) * 100 : 0)} unrealized
                </span>
              </div>
            )}
          </div>
        </ScrollReveal>

        {/* Tier 2: Total Deposited / LP Value / Open Positions / Idle Deposits */}
        <ScrollReveal stagger={0.08}>
          <div className="mb-8 grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {/* #863: gate loading shimmer on walletConnected; show "\u2014" (muted) when no wallet */}
            {[
              {
                label: "Total Deposited",
                value: !walletConnected ? "\u2014" : (loading || tokenMetasLoading) ? "\u2026" : `$${usdTotals.depositedUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]",
              },
              {
                label: "LP Value",
                value: !walletConnected ? "\u2014" : lpPositions.loading ? "\u2026" : `$${lpPositions.totalRedeemable.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : lpPositions.totalRedeemable > 0 ? "text-[var(--cyan)]" : "text-[var(--text-secondary)]",
                sub: walletConnected && lpPositions.positions.length > 0
                  ? `${lpPositions.positions.length} pool${lpPositions.positions.length > 1 ? "s" : ""}`
                  : undefined,
              },
              {
                label: "Open Positions",
                value: !walletConnected ? "\u2014" : loading ? "\u2026" : openPositions.length.toString(),
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]",
                sub: walletConnected && atRiskCount > 0 ? `${atRiskCount} at risk` : undefined,
                subColor: atRiskCount > 0 ? "text-[var(--short)]" : undefined,
              },
              {
                label: "Idle Deposits",
                value: !walletConnected ? "\u2014" : (loading || tokenMetasLoading) ? "\u2026" : `$${idleDepositsUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                color: !walletConnected ? "text-[var(--text-dim)]" : "text-[var(--text)]",
                sub: walletConnected && idleDeposits.length > 0 ? `${idleDeposits.length} market deposit${idleDeposits.length === 1 ? "" : "s"}` : undefined,
              },
            ].map((stat) => (
              <div key={stat.label} className="bg-[var(--panel-bg)] p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">{stat.label}</p>
                <p className={`text-xl font-bold tabular-nums ${stat.color}`} style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                  {stat.value}
                </p>
                {stat.sub && (
                  <p className={`mt-0.5 text-[10px] font-medium ${stat.subColor ?? stat.color}`}>
                    {stat.sub}
                  </p>
                )}
              </div>
            ))}
          </div>
        </ScrollReveal>

        {/* Positions */}
        <ScrollReveal delay={0.2}>
          {/* #863: only show shimmer when wallet is actually connected (prevents infinite skeleton when unauthenticated) */}
          {(loading || tokenMetasLoading) && walletConnected ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="border border-[var(--border)] bg-[var(--panel-bg)] p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <ShimmerSkeleton className="h-5 w-28" />
                      <ShimmerSkeleton className="h-5 w-14 rounded" />
                      <ShimmerSkeleton className="h-5 w-10 rounded" />
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <ShimmerSkeleton className="h-5 w-20" />
                      <ShimmerSkeleton className="h-4 w-14" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-5">
                    {[1, 2, 3, 4, 5].map((j) => (
                      <div key={j}>
                        <ShimmerSkeleton className="h-3 w-12 mb-1.5" />
                        <ShimmerSkeleton className="h-4 w-16" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : openPositions.length === 0 ? (
            <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-10 text-center">
              <h3 className="mb-1 text-[15px] font-semibold text-[var(--text)]">No open positions</h3>
              <p className="mb-4 text-[13px] text-[var(--text-secondary)]">
                {idleDeposits.length > 0
                  ? "Your deposited collateral is listed under Market Deposits below."
                  : "Browse markets to start trading."}
              </p>
              <Link href="/markets">
                <GlowButton>Browse Markets</GlowButton>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {openPositions.map((pos, i) => (
                <PositionCard
                  key={`${pos.slabAddress}-${i}`}
                  pos={pos}
                  label={marketLabel(pos)}
                  baseSymbol={(pos.symbol ?? statsMap.get(pos.slabAddress)?.symbol ?? pos.slabAddress.slice(0, 6)).replace(/-PERP$/i, "")}
                  collateralSymbol={tokenMetaMap.get(pos.collateralMint.toBase58())?.symbol ?? "USDC"}
                  decimals={getDecimals(pos)}
                  onRefresh={refresh}
                />
              ))}
            </div>
          )}
        </ScrollReveal>

        {/* Market deposits — funded accounts with NO open position. Shown
            separately from positions: it's the user's parked collateral, and
            mixing it into the positions list (as identical flat rows) read as
            broken/mock data. */}
        {connected && !loading && idleDeposits.length > 0 && (
          <ScrollReveal delay={0.22}>
            <div className="mt-8">
              <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                // market deposits
              </h2>
              <div className="space-y-px border border-[var(--border)]">
                {idleDeposits.map((pos, i) => (
                  <Link
                    key={`${pos.slabAddress}-dep-${i}`}
                    href={`/trade/${pos.slabAddress}`}
                    className="flex items-center justify-between gap-4 bg-[var(--panel-bg)] px-4 py-3 transition-colors hover:bg-[var(--bg-elevated)]"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}>
                        {marketLabel(pos)}
                      </span>
                      <span className="rounded bg-[var(--bg-elevated)] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)]">
                        idle collateral
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-[12px] tabular-nums text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                        {formatTokenAmount(pos.account?.capital ?? 0n, getDecimals(pos), 3)}{" "}
                        <span className="text-[10px] text-[var(--text-secondary)]">
                          {tokenMetaMap.get(pos.collateralMint.toBase58())?.symbol ?? "USDC"}
                        </span>
                      </span>
                      <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--accent)]">Trade →</span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </ScrollReveal>
        )}

        {/* LP positions */}
        <ScrollReveal delay={0.25}>
          <div className="mt-8">
            <LpPositionsPanel
              loading={lpPositions.loading}
              positions={lpPositions.positions}
              totalRedeemable={lpPositions.totalRedeemable}
              error={lpPositions.error}
              onRetry={lpPositions.refresh}
            />
          </div>
        </ScrollReveal>

        {/* Trade history + stats — PERC-481, lazy-loaded (PERF PLAN #4) */}
        <ScrollReveal delay={0.3}>
          <div className="mt-8">
            <h2 className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // trade history
            </h2>
            <ActivitySection
              wallet={walletPublicKey?.toBase58() ?? null}
              pageSize={20}
              traderStats={traderStats}
              statsMap={statsMap}
            />
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
