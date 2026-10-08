"use client";

/**
 * Phase 5 (trade-terminal rebuild): the new positions dock.
 *
 * "Push ALL math to the SDK/compute layer... UI = pure formatters" — this
 * was already largely true of `PositionsTable.tsx` (read in full before
 * writing this file): every number rendered there is a direct call to
 * `computeMarkPnl`/`computeLiqPrice`/`computePnlPercent` from `lib/trading`
 * (the same primitives the SDK-adjacent layer exposes), never inline math.
 * What Phase 5 actually changes: (1) isolates the live-price-dependent row
 * into its own `React.memo`'d leaf (`PositionRow`) so a price tick
 * re-renders *only* that leaf, not the whole dock (tab chrome, Trades tab,
 * parent cascade) — same technique validated on `TradingChart` in Phase 2;
 * (2) adds GMX-style pool-capped PnL (`perp-dex-reference-patterns.md` Area
 * 5: "a winning position's paper PnL can't exceed what the pool can
 * actually pay" — directly relevant here since Percolator's LP vault is the
 * real counterparty, not a matched order book) as an honest, DISPLAY-ONLY
 * addition using data already read elsewhere (`engine.vault` +
 * `engine.insuranceFund.balance` — the exact same fields
 * `TradeForm`/`OrderTicket` already read for their vault-empty guard); (3)
 * memoizes the whole exported component so the frequent parent
 * (`TradePageInner`) re-renders don't cascade in either.
 *
 * Close reuses `useClosePosition` unchanged (byte-identical call to
 * `PositionsTable`'s). Deposit is not duplicated here — Phase 4's
 * `OrderTicket` already owns the deposit entry point (its account row).
 */

import { computeMarginCushion, severityFromCushion } from "@/lib/liquidation-risk";
import { FC, memo, useMemo, useState } from "react";
import { useUserAccount, useUserAccountScanPending } from "@/hooks/useUserAccount";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { PositionNftMenu, ClosedPositionNftNotice, NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";
import { useClosePosition } from "@/hooks/useClosePosition";
import { AddMarginModal } from "@/components/trade/AddMarginModal";
import { PnlShareButton } from "@/components/share/PnlShareButton";
import { isPnlPoolCapped, poolPayableCapacity, type PnlCardData } from "@/lib/pnl-card";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useMarketLimits } from "@/hooks/useMarketLimits";
import { PositionLimitsRow } from "@/components/limits/PositionLimitsRow";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { AccountKind } from "@percolatorct/sdk";
import {
  formatTokenAmount,
  formatUsdPriceE6,
  formatUsdAmount,
  formatPnl,
  formatPercent,
} from "@/lib/format";
import {
  UNKNOWN_ENTRY_TOOLTIP,
  computePositionInitialMargin,
} from "@/lib/trading";
import { isEntryKnown, isExactEntrySource, DERIVED_ENTRY_TOOLTIP, ESTIMATE_LABEL } from "@/lib/entry-price-display";
import {
  adlSideFactor,
  effectiveExposureQ,
  isDeleveraged,
  adlRemainingBps,
  adlReductionTooltip,
} from "@/lib/v17-adl";
import { isMockMode } from "@/lib/mock-mode";
import { bigintToFloat } from "@/lib/formatters";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { ClosePositionModal } from "./ClosePositionModal";
import { OtherMarketPositions } from "./OtherMarketPositions";
import { WarmupProgress } from "./WarmupProgress";
import { useMarketFillCap } from "@/hooks/useMarketFillCap";
import { TradeHistory } from "./TradeHistory";
import { InfoIcon } from "@/components/ui/Tooltip";
import {
  computePositionLeverage,
  describePositionLeverage,
  POSITION_LEVERAGE_LABEL,
  POSITION_LEVERAGE_TITLE,
} from "@/lib/position-leverage";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { onChainMarkE6, terminalPositionPnl } from "@/lib/position-pnl";
import { isSentinelValue } from "@/lib/health";
import { RenderProfiler } from "@/components/dev/RenderProfiler";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";
import { describeLiqDistance, describeLiqPrice } from "@/lib/liq-price-display";
import { LiqPriceValue } from "./LiqPriceValue";
import { positionSizeUsdText } from "@/lib/q-usd";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function EmptyState({ subtitle, title = "No open positions" }: { subtitle: string; title?: string }) {
  return (
    <div className="py-10 text-center">
      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)]/30">
        <svg className="h-4 w-4 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
        </svg>
      </div>
      <p className="text-[11px] font-medium text-[var(--text)]">{title}</p>
      <p className="mt-1 text-[10px] text-[var(--text-secondary)] max-w-[220px] mx-auto leading-relaxed">{subtitle}</p>
    </div>
  );
}

/**
 * Isolated, memoized position row. Reads live price via its OWN
 * `useLivePrice()` call — the price-store subscription (Phase 1) lives
 * here, not in the parent `PositionsDock`, so a tick re-renders only this
 * leaf. `React.memo` on top means even a parent re-render for an unrelated
 * reason (Phase 0/3's documented TradePageInner cascade) skips this row
 * unless its own props (slabAddress, a stable string) actually change.
 */
const PositionRow: FC<{ slabAddress: string; wrappedRow?: boolean }> = memo(function PositionRow({ slabAddress, wrappedRow }) {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  // GH#2707: while the portfolio scan is in flight a null account is unknown, not absent.
  const scanPending = useUserAccountScanPending();
  const accountPending = !mockMode && !userAccount && scanPending;
  const config = useMarketConfig();
  const { accounts, config: mktConfig, params, adlFactors, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const { engine, insuranceBalance } = useEngineState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const decimals = tokenMeta?.decimals ?? 6;
  // P3 skew funding / liquidation drift (flag-gated; "off" = no RPC).
  const marketLimits = useMarketLimits(slabAddress);
  // T3-dd: `symbol` sometimes already carries a "-PERP" suffix from the
  // market registry (e.g. "SOL-PERP") — appending "/USD" on top of that
  // rendered "SOL-PERP/USD". Strip it once, just for the Market column label
  // below; every other `symbol` usage in this row (token amounts, tooltips)
  // is unaffected.
  const marketDisplaySymbol = symbol.replace(/-PERP$/i, "");

  const { closePosition, loading: closeLoading, error: closeError, prewarmClose, resetPhase } = useClosePosition(slabAddress);
  // Per-trade fill cap — the close modal uses it to explain multi-fill closes.
  // Only the close modal reads this, and the wrapped-extra instance never opens
  // one — an empty slab disables the hook's per-instance inventory poll there,
  // so the common no-wrapped case pays no second poll.
  const fillCaps = useMarketFillCap(wrappedRow ? "" : slabAddress);
  // Called unconditionally, before the `!activeInfo` early return below, per
  // rules of hooks — mirrors MarketInfoBar's MarkPrice / MarketBookCard's
  // Oracle cell (same shared hook, see hooks/usePriceFlash.ts).
  const markFlash = usePriceFlash(livePriceE6 ?? null);
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  // H7: "keeper" added to the mode set — this gate previously only fired for
  // admin/hyperp markets, so a stale keeper-priced market (all 5 live
  // playground markets) never blocked closing.
  const oracleStale = !mockMode && (oracleUnavailable || isOracleStaleBlocking(oracleLevel, oracleMode, oracleReady));
  // H6: engine accrue-staleness — distinct from the oracle-push freshness
  // above. A market can look perfectly fresh here (keeper still pushing
  // prices) while the ENGINE hasn't accrued in ~500 slots, cliff-dead and
  // permanently reverting every close (UX WP-2: only beyond the app's own catch-up). See
  // useEngineFreshness's file header.
  const { engineStale } = useEngineFreshness();
  const closeBlockedByStaleness = !mockMode && (oracleStale || engineStale);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showMarginModal, setShowMarginModal] = useState(false);

  const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  // If the wallet has no directly-owned position on this market, it may have
  // WRAPPED it into a Position NFT — MintPositionNft escrows the portfolio to
  // the NFT program's PDA, so useUserAccount can no longer see it and the
  // position would otherwise vanish from the dock. Only scan for it in that
  // case (zero extra RPC in the common path).
  const ownHasPosition = !!userAccount && userAccount.account.positionSize !== 0n;
  // Audit #40: a wallet can hold BOTH (wrap, then open a fresh position on the
  // same market — or receive a transferred Position NFT). The dock renders a
  // second PositionRow with `wrappedRow` for that case; the scan is shared
  // (lib/userAccountScan), so both instances join one RPC query.
  const hasNormalPosition = !wrappedRow && ownHasPosition;
  const wrapped = useNftWrappedPosition(slabAddress, !hasNormalPosition && !mockMode);
  const activeInfo = hasNormalPosition ? userAccount : wrapped;
  const isNftWrapped = !hasNormalPosition && !!wrapped;
  // Instant reflection of a just-confirmed trade (lib/userAccountScan.ts's
  // applyConfirmedFill): the SIZE shown is already an on-chain-confirmed
  // fact, not a guess — this flag only means capital/pnl on this same row
  // are still the pre-trade values for another second or two, while the
  // real scan (already in flight) reconciles them. Subtle affordance only;
  // never blocks interaction.
  const isSettling = hasNormalPosition && !!realUserAccount?.provisional;

  // The wrapped-extra row only exists to show a wrapped position ALONGSIDE an
  // owned one; with no owned position the primary row already shows the wrapped
  // position (and the empty state belongs to the primary row alone).
  if (wrappedRow && (!ownHasPosition || !wrapped)) return null;

  if (!activeInfo) {
    // A position closed while wrapped as an NFT has no row (useNftWrappedPosition skips size-0 legs), so its
    // Unwrap lives under the empty state; renders nothing unless the wallet holds such an NFT on this market.
    // While the portfolio scan is pending (#2707) say "Loading", not "no account" (#2933).
    const subtitle = accountPending
      ? "Checking this market for your account."
      : userAccount
        ? "Use the order ticket to open a position."
        : "Connect your wallet and deposit collateral to start trading.";
    return (
      <>
        <EmptyState title={accountPending ? "Loading positions…" : undefined} subtitle={subtitle} />
        <ClosedPositionNftNotice slabAddress={slabAddress} />
      </>
    );
  }
  const { account } = activeInfo;

  const isLong = account.positionSize > 0n;
  // Auto-deleveraging scales the asset's shared per-side factor and leaves the
  // leg's stored basis alone, so `account.positionSize` is the NOMINAL basis,
  // not what the position is worth today. Everything the trader reads as size,
  // exposure or PnL must use the effective figure (lib/v17-adl.ts); closing and
  // margin keep using raw basis, which is what the engine denominates them in.
  const aSide = adlFactors ? adlSideFactor(adlFactors, isLong ? 0 : 1) : 0n;
  const wasDeleveraged = !!adlFactors && isDeleveraged(account.adlABasis, aSide);
  const adlRemaining = adlFactors ? adlRemainingBps(account.adlABasis, aSide) : 10000;
  /** Nominal basis, shown only to explain an ADL reduction. */
  const absNominal = abs(account.positionSize);
  // v17 `markEwmaE6` is already post-inversion; only legacy v12 applies `invert` (see onChainMarkE6).
  const onChainPriceE6 = onChainMarkE6(config, wrapperConfigV17 !== null);
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;
  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const hasValidMark = currentPriceE6 > 0n;
  // ONE shared computation for every PnL surface (lib/position-pnl.ts, #3077):
  // ADL-effective size (never raw basis when the factors are unknown), entry
  // server > cache (this device) > back-solved estimate, valued at the MARK (what
  // liquidation uses), ROE on the position's own initial margin. The back-solve
  // runs over EFFECTIVE size - the size the on-chain pnl was earned on - so the
  // dock, badge, bar and portfolio card cannot disagree. With no entry, or with
  // the ADL factors unknown, PnL is "--" (a mark-valued placeholder would read a
  // false $0 on a position that may be deep underwater - see resolveEntryPrice).
  const pnlResult = terminalPositionPnl({
    account,
    slabAddress,
    accountIdx: activeInfo.idx,
    adlFactors,
    adlApplicable: wrapperConfigV17 !== null,
    markE6: currentPriceE6,
    anchorMarkE6: onChainPriceE6 ?? undefined,
    initialMarginBps,
    maintenanceMarginBps: maintenanceBps,
  });
  const effectiveSize = pnlResult.effectiveSize ?? account.positionSize;
  const absPosition = abs(effectiveSize);
  // "≈ $200.12" under the base-unit size: effective size at the mark; nothing without a mark.
  const sizeUsd = positionSizeUsdText(effectiveSize, currentPriceE6);
  const entryPriceE6 = pnlResult.entry;
  /** False when entry (and therefore PnL/ROE) cannot be honestly displayed. */
  const pnlIsKnown = pnlResult.pnlKnown;
  const entryKnown = isEntryKnown(pnlResult.entry, pnlResult.entrySource);
  const pnlTokens = pnlResult.unrealizedPnl ?? 0n;
  // sim-USDC is $1-pegged collateral (see PLAYGROUND.md) - the collateral
  // amount above already IS the dollar figure, just formatted differently.
  // #2324: null rather than a silently-wrong figure above MAX_SAFE_INTEGER.
  const pnlUsdRaw = hasValidMark ? bigintToFloat(pnlTokens, decimals) : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = pnlResult.roe ?? 0;

  // GMX-style pool-capped PnL: the LP vault is the real counterparty (not a
  // matched order book) — a winning position's paper PnL can't exceed what
  // the vault + insurance fund can actually pay out. Display-only: does not
  // change settlement, just surfaces the same caveat GMX shows when
  // `cappedPnl !== poolPnl`. `engine.vault` is v12-only (legacy engine block;
  // always null on v17, and there's no v17 vault-capital field readable
  // client-side — same limitation MarketInfoBar's BUG 21 fix documents).
  // `insuranceBalance` is `useEngineState()`'s unified v12/v17 field
  // (`engine.insuranceFund.balance` on v12, `parseMarketGroupV17OI` on v17),
  // so this gate at least fires off insurance capacity on v17 instead of
  // silently reading 0 forever (engine.insuranceFund is always null there).
  const payableCapacity = poolPayableCapacity(engine?.vault, insuranceBalance);
  // Same predicate the Share-PnL card applies (lib/pnl-card), so they can't drift.
  const pnlIsCapped = hasValidMark && isPnlPoolCapped(pnlTokens, payableCapacity);

  // Current effective leverage on the cross-margined portfolio (notional /
  // (capital + pnl)); NOT entry leverage — see lib/position-leverage.ts.
  const leverageDisplay = describePositionLeverage(
    computePositionLeverage({
      sizeQ: account.positionSize,
      markPriceE6: hasValidMark ? currentPriceE6 : null,
      capital: account.capital,
      pnl: account.pnl,
      collateralDecimals: decimals,
    }),
  );

  // Liquidation price on EFFECTIVE size (engine maintenance runs over effective_abs_q,
  // v16.rs:13896-13912); unknown ADL state => no number (0n), and the row falls back
  // to margin health because `pnlIsKnown` is false.
  const liqPriceE6 = pnlResult.liquidationPriceE6 ?? 0n;
  // Long-side clamp: liq at/below $0 with a live position = cannot be
  // liquidated by price (excess collateral) — formatLiqPrice renders "∞".
  const liqUnliquidatable = pnlResult.adlKnown && liqPriceE6 <= 0n && entryPriceE6 > 0n && account.positionSize !== 0n;
  // When there is no liquidation price, "no liquidation price" is not a risk
  // figure. Margin health is: capital/notional, defined without an entry or a
  // liq price, and it crosses its threshold at exactly the collateral level
  // where the liq price disappears. See lib/margin-health.ts and #2558.
  const liqDisplay = describeLiqPrice({
    liqPriceE6,
    positionSize: account.positionSize,
    capital: account.capital,
    markPriceE6: currentPriceE6,
    maintenanceMarginBps: maintenanceBps,
    // #2660: `entryPriceE6 > 0n` is always true — on "unknown" it is the mark.
    hasResolvedEntry: pnlIsKnown,
  });
  // "5.3% to liq" under a real price only; the "% mgn" / unknown cells stay as they are.
  const liqDistance = describeLiqDistance(liqDisplay, account.positionSize, currentPriceE6, liqPriceE6);
  const liqPriceColor = (() => {
    if (liqUnliquidatable) return "text-[var(--text-secondary)]";
    if (liqPriceE6 <= 0n) return "text-[var(--text-secondary)]";
    if (!hasValidMark || currentPriceE6 <= 0n) return "text-[var(--warning)]";
    // Same tiers as the site-wide liquidation warning: the share of this position's
    // margin cushion left (lib/liquidation-risk.ts), not a flat price distance.
    // EFFECTIVE size, like the liquidation line above it (engine margin runs over
    // effective_abs_q). Unknown ADL state => not measurable (null), never a raw-size tier.
    const cushion = pnlResult.effectiveSize === null ? null : computeMarginCushion({
      positionSize: pnlResult.effectiveSize,
      entryPriceE6,
      capital: account.capital,
      markPriceE6: currentPriceE6,
      maintenanceMarginBps: maintenanceBps,
      initialMarginBps,
    });
    const tier = cushion == null ? "safe" : severityFromCushion(cushion);
    if (tier === "danger") return "text-[var(--short)]";
    if (tier === "warning") return "text-[var(--warning)]";
    return "text-[var(--text-secondary)]";
  })();
  const pnlColor = pnlTokens === 0n ? "text-[var(--text-muted)]" : pnlTokens > 0n ? "text-[var(--long)]" : "text-[var(--short)]";
  const roeColor = roe === 0 ? "text-[var(--text-muted)]" : roe > 0 ? "text-[var(--long)]" : "text-[var(--short)]";

  // "Share PnL" card data — only when we can price the PnL honestly: a live mark
  // and the entry CACHED at open (server/cache, never an estimate); never a derived/estimated entry. The pool payout capacity
  // rides along so the card caps exactly where this row shows its caveat.
  const pnlCardData: PnlCardData | null =
    hasValidMark && pnlIsKnown && isExactEntrySource(pnlResult.entrySource) && entryPriceE6 > 0n
      ? {
          slab: slabAddress,
          symbol: marketDisplaySymbol,
          name: marketInfo?.name ?? marketDisplaySymbol,
          logoUrl: marketInfo?.logo_url ?? null,
          mainnetCa: marketInfo?.mainnet_ca ?? null,
          payableCapacityAtoms: payableCapacity,
          decimals,
          nominalSizeQ: account.positionSize,
          effectiveSizeQ: effectiveSize,
          entryE6: entryPriceE6,
          initialMarginBps,
          initialMarkE6: currentPriceE6,
        }
      : null;

  const handleConfirmClose = async (percent: number) => {
    try {
      await closePosition(percent);
      setShowCloseModal(false);
    } catch {
      // error surfaced via hook state below
    }
  };

  return (
    <div>
      {/* The wrapped-extra row reads as its own labeled section, the same grammar
          as "// other markets"; market-level banners and warmup stay on the
          primary instance so they never render twice. */}
      {wrappedRow && (
        <div className="flex items-center gap-2 border-t border-[var(--border)]/40 px-4 pb-1 pt-3">
          <span className="text-[9px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/80">
            // wrapped as nft
          </span>
        </div>
      )}
      {!wrappedRow && lpUnderfunded && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">Low liquidity</span>
        </div>
      )}
      {/* UX WP-2 (SH-3): the engine is catching up beyond the app's own repair; calm, clears itself. */}
      {!wrappedRow && engineStale && !oracleStale && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">Catching up with the latest prices</span>
        </div>
      )}
      {isNftWrapped && (
        <div className="border-b border-[var(--accent)]/20 bg-[var(--accent)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--accent)]">
            {/* The Position NFT panel was removed (UX WP-9): Unwrap lives in the row's ⋯ menu. */}
            🎫 {NFT_MENU_COPY.wrappedHint}
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-[10px]">
          <thead>
            <tr className="border-b border-[var(--border)]/30 text-[8px] uppercase tracking-[0.15em] text-[var(--text)]">
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">Market</th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Side</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Size</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                <span className="inline-flex items-center justify-end gap-1">
                  {POSITION_LEVERAGE_LABEL}
                  <InfoIcon tooltip={POSITION_LEVERAGE_TITLE} />
                </span>
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Entry</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Mark</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Liq. Price</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">PnL</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">ROE%</th>
              {/* Pinned to the right edge so the Share/Close actions stay reachable
                  when this wide table scrolls horizontally on a phone. */}
              <th className="sticky right-0 z-20 whitespace-nowrap border-l border-[var(--border)]/30 bg-[var(--panel-bg)] px-3 py-2 text-right font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="position-row" className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
              <td className="whitespace-nowrap px-4 py-2.5 text-left"><span className="text-[11px] font-medium text-[var(--text)]">{marketDisplaySymbol}/USD</span></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-left">
                <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${isLong ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"}`}>
                  {isLong ? "LONG" : "SHORT"}
                </span>
                {isNftWrapped && (
                  <span data-testid="position-nft-badge" className="ml-1 inline-block rounded-sm bg-[var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--accent)]" title="This position is wrapped in a Position NFT you hold.">
                    {NFT_MENU_COPY.badge}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                <span className="text-[var(--text)]">{formatTokenAmount(absPosition, decimals)}</span>
                <span className="ml-1 text-[var(--text-secondary)]">{symbol}</span>
                {wasDeleveraged && (
                  <span
                    className="ml-1 inline-block rounded-sm bg-[var(--short)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--short)]"
                    title={adlReductionTooltip(absNominal, absPosition, adlRemaining, decimals, symbol)}
                  >
                    ADL
                  </span>
                )}
                {isSettling && (
                  <span
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]/60 animate-pulse align-middle"
                    title="Size reflects your confirmed trade — balance is still settling"
                  />
                )}
                {sizeUsd && (
                  <div data-testid="position-size-usd" className="text-[9px] text-[var(--text-secondary)]">
                    {sizeUsd}
                  </div>
                )}
              </td>
              <td
                className={`whitespace-nowrap px-3 py-2.5 text-right ${leverageDisplay.known ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                title={leverageDisplay.title}
                data-testid="position-leverage"
              >
                {leverageDisplay.text}
              </td>
              <td className={`whitespace-nowrap px-3 py-2.5 text-right ${pnlIsKnown ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {entryKnown ? formatUsdPriceE6(entryPriceE6) : (
                  <span className="inline-flex items-center justify-end gap-1">
                    --
                    <InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} />
                  </span>
                )}
              </td>
              <td
                className={`whitespace-nowrap px-3 py-2.5 text-right transition-colors duration-300 ease-out ${
                  hasValidMark
                    ? markFlash === "up" ? "text-[var(--long)]" : markFlash === "down" ? "text-[var(--short)]" : "text-[var(--text)]"
                    : "text-[var(--text-dim)]"
                }`}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              >
                {hasValidMark ? formatUsdPriceE6(currentPriceE6) : "--"}
              </td>
              <td
                data-testid="position-liq"
                className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${liqPriceColor}`}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              >
                <LiqPriceValue display={liqDisplay} />
                {liqDistance && (
                  <div data-testid="position-liq-distance" className="text-[9px] font-normal">
                    {liqDistance}
                  </div>
                )}
              </td>
              <td className={`whitespace-nowrap px-3 py-2.5 text-right ${hasValidMark && pnlIsKnown ? pnlColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {!pnlIsKnown ? (
                  <span className="inline-flex items-center justify-end gap-1">
                    --
                    <InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} />
                  </span>
                ) : hasValidMark ? (
                  <>
                    <div className="flex items-center justify-end gap-1">
                      {formatPnl(pnlTokens, decimals)} {collateralSymbol}
                      {pnlResult.isEstimate && (
                        <span className="text-[9px] font-normal text-[var(--text-dim)]" title={DERIVED_ENTRY_TOOLTIP}>{ESTIMATE_LABEL}</span>
                      )}
                      {pnlIsCapped && (
                        <InfoIcon tooltip={`Vault + insurance can currently pay up to ${formatTokenAmount(payableCapacity, decimals)} ${collateralSymbol} of profit on this market. Your paper PnL exceeds that — payout may be capped at close, same as any pool-backed perp.`} />
                      )}
                    </div>
                    {/* BUG 23 fix: was `pnlUsd >= 0 ? "+" : ""` — for a
                        negative value that left the prefix EMPTY (not "-"),
                        so -$5.30 rendered as "$5.30" with sign carried only
                        by color. Sign from `pnlTokens` (the same
                        collateral-scale bigint `formatPnl` above already
                        signs correctly) rather than re-deriving it from the
                        float. */}
                    {pnlUsd !== null && (
                      <div className="text-[9px]">
                        {formatUsdAmount(pnlUsd, pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : "")}
                      </div>
                    )}
                  </>
                ) : (
                  <span>--</span>
                )}
              </td>
              <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${hasValidMark && pnlIsKnown ? roeColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {hasValidMark && pnlIsKnown ? formatPercent(roe) : "--"}
              </td>
              <td className="sticky right-0 z-10 has-[[role=menu]]:z-30 whitespace-nowrap border-l border-[var(--border)]/30 bg-[var(--panel-bg)] px-3 py-2.5 text-right">
                <span className="inline-flex items-center justify-end gap-1">
                <PnlShareButton
                  data={pnlCardData}
                  label="Share PnL"
                  className="rounded-none border border-[var(--accent)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--accent)]/8 hover:border-[var(--accent)]/50"
                />
                {isNftWrapped ? (
                  <span data-testid="position-close-wrapped" className="text-[9px] text-[var(--text-secondary)]">
                    {NFT_MENU_COPY.closeWrapped}
                  </span>
                ) : (
                  <>
                  {/* #3304: add margin to THIS row's own account. Owned row only: collateral cannot back a
                      position held in an NFT. The modal deposits into the account the row shows. */}
                  {!mockMode && (
                    <button
                      onClick={() => setShowMarginModal(true)}
                      data-testid="position-add-margin"
                      className="rounded-none border border-[var(--accent)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--accent)]/8 hover:border-[var(--accent)]/50"
                    >
                      + Margin
                    </button>
                  )}
                  <button
                    // prewarmClose: start the fresh position read + tx prewarms
                    // the moment the modal opens, so the confirm click reaches
                    // the wallet popup with zero blocking round-trips.
                    onClick={() => { resetPhase(); prewarmClose(); setShowCloseModal(true); }}
                    data-testid="position-close"
                    disabled={closeLoading || lpUnderfunded || !hasValidMark || engineStale}
                    title={!hasValidMark ? "Waiting for price data…" : engineStale ? "Prices are catching up. Closing resumes once the market has caught up." : undefined}
                    className="rounded-none border border-[var(--short)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 hover:border-[var(--short)]/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Close
                  </button>
                  </>
                )}
                {/* UX WP-9 (§3.13): Wrap / Send / Unwrap live in this row's "⋯" menu. */}
                <PositionNftMenu slabAddress={slabAddress} row={isNftWrapped ? "wrapped" : "own"} />
                </span>
              </td>
            </tr>
            {marketLimits.flags.p3 && (
              <tr data-testid="limits-position-row" className="border-b border-[var(--border)]/20">
                <td colSpan={99} className="px-4 pb-2">
                  <PositionLimitsRow
                    limits={marketLimits}
                    positionQ={effectiveSize}
                    priceE6={currentPriceE6}
                    marginAboveMaintAtoms={account.capital - (absPosition * currentPriceE6 * maintenanceBps) / 1_000_000n / 10_000n}
                    decimals={decimals}
                    collateralSymbol={collateralSymbol}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!wrappedRow && (
        <div className="px-4 py-2">
          <WarmupProgress slabAddress={slabAddress} accountIdx={activeInfo.idx} />
        </div>
      )}
      {closeError && (
        <div data-testid="position-close-error" className="mx-4 mb-3 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{closeError}</p>
        </div>
      )}
      {showMarginModal && !isNftWrapped && (
        <AddMarginModal
          slabAddress={slabAddress}
          userIdx={activeInfo.idx}
          symbol={collateralSymbol}
          decimals={decimals}
          portfolioPk={activeInfo.pubkey}
          onClose={() => setShowMarginModal(false)}
          onSuccess={refreshSlab}
        />
      )}
      {showCloseModal && (
        <ClosePositionModal
          // EFFECTIVE exposure: this modal previews size and PnL for the close, and
          // raw basis over-reports a deleveraged leg (#3077). The close itself
          // re-reads the leg from a fresh scan (see useClosePosition).
          positionSize={effectiveSize}
          previewUnavailable={!pnlResult.adlKnown}
          entryPrice={pnlIsKnown ? entryPriceE6 : 0n}
          currentPrice={currentPriceE6}
          capital={account.capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          error={closeError}
          tradingFeeBps={params?.tradingFeeBps}
          // Defense-in-depth: the row-level Close button above is already
          // disabled on engineStale (with its own correctly-labeled title),
          // but if the modal is somehow already open when engine-staleness
          // is detected, keep its Confirm button blocked too.
          oracleStale={closeBlockedByStaleness}
          maxFillAbs={fillCaps?.maxFillAbs ?? null}
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseModal(false)}
        />
      )}
    </div>
  );
});

/** Local tab strip — same shape as page.tsx's, kept self-contained so this
 *  file doesn't depend on the page module (cleaner boundary for a component
 *  that page.tsx imports, not the other way around). */
function DockTabs({ tabs, children }: { tabs: string[]; children: React.ReactNode[] }) {
  const [active, setActive] = useState(0);
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 overflow-x-auto border-b border-[var(--border)]/50 whitespace-nowrap scrollbar-none">
        {tabs.map((label, i) => (
          <button
            key={label}
            onClick={() => setActive(i)}
            className={`shrink-0 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors duration-150 border-b-2 ${
              active === i ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text)] hover:border-[var(--border)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children[active]}</div>
    </div>
  );
}

/**
 * Phase 5 (trade-terminal rebuild): PositionsDock. Memoized so a parent
 * re-render (TradePageInner) doesn't cascade in — same technique validated
 * on TradingChart in Phase 2. Safe because its only prop is a stable string.
 */
const PositionsDockInner: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  return (
    <DockTabs tabs={["Positions", "Trades"]}>
      {/* Nested profiler boundary — lets verification distinguish "the
          isolated row's own legitimate price-driven re-renders" from "the
          outer dock shell re-rendering for some other reason." If memo is
          doing its job, this count should track closely with the outer
          PositionsDock boundary's count (see BUILD-LOG.md Phase 5) — i.e.
          the shell isn't adding re-renders on top of what the row itself
          needs. */}
      <div>
        {/* This market's position stays pinned first, its own labeled
            section; every other market the wallet holds follows below so a
            trader never navigates away just to watch or close elsewhere. */}
        <div className="flex items-center gap-2 px-4 pb-1 pt-3">
          <span className="text-[9px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/80">
            // this market
          </span>
        </div>
        <RenderProfiler id="PositionRow">
          <PositionRow slabAddress={slabAddress} />
        </RenderProfiler>
        {/* Audit #40: wrap, then open a fresh position on the same market (or
            receive a transferred Position NFT) — the wallet holds both; this
            instance shows the wrapped one. Renders null unless both exist. */}
        <RenderProfiler id="PositionRowWrapped">
          <PositionRow slabAddress={slabAddress} wrappedRow />
        </RenderProfiler>
        <OtherMarketPositions currentSlab={slabAddress} />
      </div>
      <TradeHistory slabAddress={slabAddress} />
    </DockTabs>
  );
};

export const PositionsDock = memo(PositionsDockInner);
