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
import { useUserAccount, useUserAccountScanPending, useOwnerMarketPortfolios } from "@/hooks/useUserAccount";
import type { UserAccountInfo } from "@/lib/userAccountScan";
import { computePositionRowView } from "@/lib/position-row-view";
import { PublicKey } from "@solana/web3.js";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { PositionNftMenu, ClosedPositionNftNotice, NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useDeposit } from "@/hooks/useDeposit";
import { useWithdraw } from "@/hooks/useWithdraw";
import { parseHumanAmount } from "@/lib/parseAmount";
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
const PositionRow: FC<{ slabAddress: string }> = memo(function PositionRow({ slabAddress }) {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  // GH#2707: while the portfolio scan is in flight a null account is unknown, not absent.
  const scanPending = useUserAccountScanPending();
  const accountPending = !mockMode && !userAccount && scanPending;
  const config = useMarketConfig();
  const { accounts, config: mktConfig, params, adlFactors, wrapperConfigV17 } = useSlabState();
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
  const fillCaps = useMarketFillCap(slabAddress);
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

  const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  // If the wallet has no directly-owned position on this market, it may have
  // WRAPPED it into a Position NFT — MintPositionNft escrows the portfolio to
  // the NFT program's PDA, so useUserAccount can no longer see it and the
  // position would otherwise vanish from the dock. Only scan for it in that
  // case (zero extra RPC in the common path).
  const hasNormalPosition = !!userAccount && userAccount.account.positionSize !== 0n;
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
    // #2560: read THIS (primary) portfolio's own cached entry — the primary may
    // be an isolated portfolio (lowest random pubkey). Legacy fallback (default)
    // still resolves a cross primary's entry; single-portfolio is unchanged.
    portfolio: activeInfo.pubkey?.toBase58(),
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
      {lpUnderfunded && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">Low liquidity</span>
        </div>
      )}
      {/* UX WP-2 (SH-3): the engine is catching up beyond the app's own repair; calm, clears itself. */}
      {engineStale && !oracleStale && (
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
                )}
                {/* UX WP-9 (§3.13): Wrap / Send / Unwrap live in this row's "⋯" menu. */}
                <PositionNftMenu slabAddress={slabAddress} />
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
      <div className="px-4 py-2">
        <WarmupProgress slabAddress={slabAddress} accountIdx={activeInfo.idx} />
      </div>
      {closeError && (
        <div data-testid="position-close-error" className="mx-4 mb-3 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{closeError}</p>
        </div>
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
 * #2560: add / remove collateral on a specific ISOLATED portfolio. Rides the
 * existing deposit/withdraw hooks, which already take an explicit portfolioPk
 * (so the funds move to/from exactly this portfolio, not the primary). Add
 * increases the position's margin (farther liq); Remove withdraws free margin.
 */
const AdjustMarginModal: FC<{
  slabAddress: string;
  portfolio: PublicKey;
  symbol: string;
  collateralSymbol: string;
  decimals: number;
  capital: bigint;
  onClose: () => void;
  onDone: () => void;
}> = ({ slabAddress, portfolio, symbol, collateralSymbol, decimals, capital, onClose, onDone }) => {
  const { deposit, loading: depLoading, error: depError } = useDeposit(slabAddress);
  const { withdraw, loading: wdLoading, error: wdError } = useWithdraw(slabAddress);
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [input, setInput] = useState("");
  const loading = depLoading || wdLoading;
  const error = depError || wdError;
  let amount = 0n;
  try {
    amount = input ? parseHumanAmount(input, decimals) : 0n;
  } catch {
    amount = 0n;
  }
  // Remove is bounded by the portfolio's capital here; the withdraw hook's own
  // free-margin pre-check (open-position IM floor) is the authoritative gate.
  const invalid = amount <= 0n || (mode === "remove" && amount > capital);
  const submit = async () => {
    if (invalid || loading) return;
    try {
      if (mode === "add") {
        await deposit({ userIdx: 0, amount, accountExists: true, portfolioPk: portfolio });
      } else {
        await withdraw({ userIdx: 0, amount, portfolioPk: portfolio });
      }
      onDone();
      onClose();
    } catch {
      /* error surfaced via hook state */
    }
  };
  const seg = (on: boolean) =>
    `flex-1 rounded-none border py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] transition-colors ${
      on ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]" : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text)]"
    }`;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Adjust isolated margin"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs border border-[var(--border)] bg-[var(--panel-bg)] p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold text-[var(--text)]">Adjust margin — {symbol} <span className="text-[var(--accent)]">Isolated</span></h3>
          <button onClick={onClose} aria-label="Close" className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]">✕</button>
        </div>
        <div className="mb-3 flex gap-1" role="group" aria-label="Add or remove margin">
          <button type="button" onClick={() => setMode("add")} aria-pressed={mode === "add"} data-testid="margin-add" className={seg(mode === "add")}>Add</button>
          <button type="button" onClick={() => setMode("remove")} aria-pressed={mode === "remove"} data-testid="margin-remove" className={seg(mode === "remove")}>Remove</button>
        </div>
        <label className="mb-1 block text-[9px] uppercase tracking-[0.12em] text-[var(--text-dim)]">Amount ({collateralSymbol})</label>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          data-testid="margin-amount"
          className="w-full rounded-none border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-2 text-right font-mono text-[13px] text-[var(--text)] tabular-nums focus:border-[var(--accent)] focus:outline-none"
        />
        <div className="mt-1.5 text-[10px] text-[var(--text-secondary)]">
          This position&apos;s margin: <span className="font-mono tabular-nums text-[var(--text)]">{formatTokenAmount(capital, decimals)} {collateralSymbol}</span>
        </div>
        {error && <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>}
        <button
          type="button"
          onClick={submit}
          disabled={loading || invalid}
          data-testid="margin-submit"
          className="mt-3 w-full rounded-none border border-[var(--accent)]/40 bg-[var(--accent)]/10 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Submitting…" : mode === "add" ? "Add margin" : "Remove margin"}
        </button>
      </div>
    </div>
  );
};

/**
 * #2560 isolated margin: one <tr> per portfolio for the MULTI-portfolio case.
 * Rendered by MultiPositionTable (2+ portfolios) only — the single-portfolio
 * path still uses PositionRow above UNCHANGED, so today's UI is byte-identical.
 * Every number comes from the shared pure helper computePositionRowView (the
 * SAME derivation PositionRow uses inline), threaded with this portfolio's
 * pubkey so each row reads its own cached entry.
 *
 * Positions listed here are always directly-owned: a wrapped (NFT-escrowed)
 * portfolio's mutable owner moves to the escrow PDA, so it never matches the
 * owner scan behind useOwnerMarketPortfolios — hence no NFT-wrap handling here.
 */
const PositionTableRow: FC<{ slabAddress: string; info: UserAccountInfo; isPrimary: boolean }> = memo(
  function PositionTableRow({ slabAddress, info, isPrimary }) {
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
    const marketLimits = useMarketLimits(slabAddress);
    const marketDisplaySymbol = symbol.replace(/-PERP$/i, "");
    const { closePosition, loading: closeLoading, error: closeError, prewarmClose, resetPhase } = useClosePosition(slabAddress);
    const fillCaps = useMarketFillCap(slabAddress);
    const markFlash = usePriceFlash(livePriceE6 ?? null);
    const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
    const oracleUnavailable = oracleLevel === "unavailable";
    const oracleStale = oracleUnavailable || isOracleStaleBlocking(oracleLevel, oracleMode, oracleReady);
    const { engineStale } = useEngineFreshness();
    const closeBlockedByStaleness = oracleStale || engineStale;
    const [showCloseModal, setShowCloseModal] = useState(false);
    const [showMargin, setShowMargin] = useState(false);

    const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
    const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

    const account = info.account;
    const portfolioPk = info.pubkey;
    const view = computePositionRowView({
      account,
      accountIdx: info.idx,
      slabAddress,
      portfolio: portfolioPk?.toBase58(),
      isPrimary,
      config,
      adlApplicable: wrapperConfigV17 !== null,
      adlFactors,
      livePriceE6,
      maintenanceMarginBps: params?.maintenanceMarginBps,
      initialMarginBps: params?.initialMarginBps,
      engineVault: engine?.vault,
      insuranceBalance,
      decimals,
      marketInfo,
      marketDisplaySymbol,
    });

    const handleConfirmClose = async (percent: number) => {
      try {
        // #2560 C7: a 100% close of an ISOLATED position reclaims its portfolio's
        // rent (best-effort, in useClosePosition); never for the primary/cross.
        await closePosition(percent, { portfolioPk, reclaimOnClose: !isPrimary });
        setShowCloseModal(false);
      } catch {
        /* error surfaced via hook state below */
      }
    };

    return (
      <>
        <tr data-testid="position-row" className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
          <td className="whitespace-nowrap px-4 py-2.5 text-left"><span className="text-[11px] font-medium text-[var(--text)]">{marketDisplaySymbol}/USD</span></td>
          <td className="whitespace-nowrap px-3 py-2.5 text-left">
            <span
              className={`inline-block rounded-sm border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-[0.06em] ${isPrimary ? "border-[var(--border)] text-[var(--text-secondary)]" : "border-[var(--accent)]/40 bg-[var(--accent)]/[0.07] text-[var(--accent)]"}`}
              title={isPrimary ? "Cross — shares your main account's collateral" : "Isolated — its own portfolio and margin; losses can't touch your other positions"}
            >
              {isPrimary ? "Cross" : "Isolated"}
            </span>
          </td>
          <td className="whitespace-nowrap px-3 py-2.5 text-left">
            <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${view.isLong ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"}`}>
              {view.isLong ? "LONG" : "SHORT"}
            </span>
          </td>
          <td className="whitespace-nowrap px-3 py-2.5 text-right" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            <span className="text-[var(--text)]">{formatTokenAmount(view.absPosition, decimals)}</span>
            <span className="ml-1 text-[var(--text-secondary)]">{symbol}</span>
            {view.wasDeleveraged && (
              <span className="ml-1 inline-block rounded-sm bg-[var(--short)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--short)]" title={adlReductionTooltip(view.absNominal, view.absPosition, view.adlRemaining, decimals, symbol)}>ADL</span>
            )}
            {info.provisional && (
              <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]/60 animate-pulse align-middle" title="Size reflects your confirmed trade — balance is still settling" />
            )}
          </td>
          <td className={`whitespace-nowrap px-3 py-2.5 text-right ${view.leverage.known ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }} title={view.leverage.title} data-testid="position-leverage">
            {view.leverage.text}
          </td>
          <td className={`whitespace-nowrap px-3 py-2.5 text-right ${view.pnlIsKnown ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {view.entryKnown ? formatUsdPriceE6(view.entryPriceE6) : (
              <span className="inline-flex items-center justify-end gap-1">--<InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} /></span>
            )}
          </td>
          <td className={`whitespace-nowrap px-3 py-2.5 text-right transition-colors duration-300 ease-out ${view.hasValidMark ? (markFlash === "up" ? "text-[var(--long)]" : markFlash === "down" ? "text-[var(--short)]" : "text-[var(--text)]") : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {view.hasValidMark ? formatUsdPriceE6(view.currentPriceE6) : "--"}
          </td>
          <td data-testid="position-liq" className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${view.liqPriceColor}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            <LiqPriceValue display={view.liqDisplay} />
          </td>
          <td className={`whitespace-nowrap px-3 py-2.5 text-right ${view.hasValidMark && view.pnlIsKnown ? view.pnlColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {!view.pnlIsKnown ? (
              <span className="inline-flex items-center justify-end gap-1">--<InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} /></span>
            ) : view.hasValidMark ? (
              <>
                <div className="flex items-center justify-end gap-1">
                  {formatPnl(view.pnlTokens, decimals)} {collateralSymbol}
                  {view.isEstimate && <span className="text-[9px] font-normal text-[var(--text-dim)]" title={DERIVED_ENTRY_TOOLTIP}>{ESTIMATE_LABEL}</span>}
                  {view.pnlIsCapped && (
                    <InfoIcon tooltip={`Vault + insurance can currently pay up to ${formatTokenAmount(view.payableCapacity, decimals)} ${collateralSymbol} of profit on this market. Your paper PnL exceeds that — payout may be capped at close, same as any pool-backed perp.`} />
                  )}
                </div>
                {view.pnlUsd !== null && (
                  <div className="text-[9px]">{view.pnlTokens > 0n ? "+" : view.pnlTokens < 0n ? "-" : ""}${Math.abs(view.pnlUsd).toFixed(2)}</div>
                )}
              </>
            ) : (
              <span>--</span>
            )}
          </td>
          <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${view.hasValidMark && view.pnlIsKnown ? view.roeColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            {view.hasValidMark && view.pnlIsKnown ? formatPercent(view.roe) : "--"}
          </td>
          <td className="sticky right-0 z-10 has-[[role=menu]]:z-30 whitespace-nowrap border-l border-[var(--border)]/30 bg-[var(--panel-bg)] px-3 py-2.5 text-right">
            <span className="inline-flex items-center justify-end gap-1">
              {!isPrimary && (
                <button
                  type="button"
                  onClick={() => setShowMargin(true)}
                  data-testid="adjust-margin"
                  title="Add or remove collateral for this isolated position"
                  className="rounded-none border border-[var(--border)] px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
                >
                  ± Margin
                </button>
              )}
              <PnlShareButton
                data={view.pnlCardData}
                label="Share PnL"
                className="rounded-none border border-[var(--accent)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--accent)]/8 hover:border-[var(--accent)]/50"
              />
              <button
                onClick={() => { resetPhase(); prewarmClose(); setShowCloseModal(true); }}
                data-testid="position-close"
                disabled={closeLoading || lpUnderfunded || !view.hasValidMark || engineStale}
                title={!view.hasValidMark ? "Waiting for price data…" : engineStale ? "Prices are catching up. Closing resumes once the market has caught up." : undefined}
                className="rounded-none border border-[var(--short)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 hover:border-[var(--short)]/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Close
              </button>
            </span>
          </td>
        </tr>
        {marketLimits.flags.p3 && (
          <tr data-testid="limits-position-row" className="border-b border-[var(--border)]/20">
            <td colSpan={99} className="px-4 pb-2">
              <PositionLimitsRow
                limits={marketLimits}
                positionQ={view.effectiveSize}
                priceE6={view.currentPriceE6}
                marginAboveMaintAtoms={account.capital - (view.absPosition * view.currentPriceE6 * view.maintenanceBps) / 1_000_000n / 10_000n}
                decimals={decimals}
                collateralSymbol={collateralSymbol}
              />
            </td>
          </tr>
        )}
        {(closeError || showCloseModal || showMargin) && (
          <tr>
            <td colSpan={99} className="p-0">
              {showMargin && portfolioPk && (
                <AdjustMarginModal
                  slabAddress={slabAddress}
                  portfolio={portfolioPk}
                  symbol={symbol}
                  collateralSymbol={collateralSymbol}
                  decimals={decimals}
                  capital={account.capital}
                  onClose={() => setShowMargin(false)}
                  onDone={() => refreshSlab()}
                />
              )}
              {closeError && (
                <div data-testid="position-close-error" className="mx-4 mb-3 mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
                  <p className="text-[10px] text-[var(--short)]">{closeError}</p>
                </div>
              )}
              {showCloseModal && (
                <ClosePositionModal
                  positionSize={view.effectiveSize}
                  previewUnavailable={!view.adlKnown}
                  entryPrice={view.pnlIsKnown ? view.entryPriceE6 : 0n}
                  currentPrice={view.currentPriceE6}
                  capital={account.capital}
                  symbol={symbol}
                  collateralSymbol={collateralSymbol}
                  decimals={decimals}
                  priceUsd={priceUsd}
                  isLong={view.isLong}
                  loading={closeLoading}
                  error={closeError}
                  tradingFeeBps={params?.tradingFeeBps}
                  oracleStale={closeBlockedByStaleness}
                  maxFillAbs={fillCaps?.maxFillAbs ?? null}
                  onConfirm={handleConfirmClose}
                  onCancel={() => setShowCloseModal(false)}
                />
              )}
            </td>
          </tr>
        )}
      </>
    );
  },
);

/**
 * #2560: the MULTI-portfolio positions table (2+ portfolios on this market) —
 * one row per portfolio, Hyperliquid/Phoenix style, with a Cross/Isolated mode
 * badge. The lowest-pubkey portfolio (infos[0]) is the Cross/main account; the
 * rest are Isolated. Only mounted when a wallet actually holds 2+ portfolios;
 * the single-portfolio case renders PositionRow (unchanged) instead.
 */
const MultiPositionTable: FC<{ slabAddress: string; infos: readonly UserAccountInfo[]; primaryPubkey?: PublicKey }> = ({ slabAddress, infos, primaryPubkey }) => {
  const { accounts } = useSlabState();
  const { engineStale } = useEngineFreshness();
  const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;
  return (
    <div>
      {lpUnderfunded && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">Low liquidity</span>
        </div>
      )}
      {engineStale && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--text-secondary)]">Catching up with the latest prices</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-[10px]">
          <thead>
            <tr className="border-b border-[var(--border)]/30 text-[8px] uppercase tracking-[0.15em] text-[var(--text)]">
              <th className="whitespace-nowrap px-4 py-2 text-left font-medium">Market</th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Mode</th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium">Side</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Size</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
                <span className="inline-flex items-center justify-end gap-1">{POSITION_LEVERAGE_LABEL}<InfoIcon tooltip={POSITION_LEVERAGE_TITLE} /></span>
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Entry</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Mark</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Liq. Price</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">PnL</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">ROE%</th>
              <th className="sticky right-0 z-20 whitespace-nowrap border-l border-[var(--border)]/30 bg-[var(--panel-bg)] px-3 py-2 text-right font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            {infos.map((info, i) => (
              <PositionTableRow
                key={info.pubkey?.toBase58() ?? `pf-${i}`}
                slabAddress={slabAddress}
                info={info}
                // Cross = the true primary (lowest-pubkey) account, matched by
                // pubkey — NOT the filtered-list index, since the primary may be
                // flat and excluded from `infos` here. Everything else is Isolated.
                isPrimary={!!primaryPubkey && !!info.pubkey && info.pubkey.equals(primaryPubkey)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* #2560 review M2: warmup is keyed by accountIdx (always 0 on v17), so it
          can't distinguish portfolios — render it once at the market level, the
          same (slab, 0) warmup the single-row path shows. Per-portfolio warmup
          needs server-side portfolio keying (same gap as the entry cache, #211). */}
      <div className="px-4 py-2">
        <WarmupProgress slabAddress={slabAddress} accountIdx={0} />
      </div>
    </div>
  );
};

/**
 * #2560: chooses the single-portfolio PositionRow (today's UI, untouched) or the
 * multi-portfolio table based on how many portfolios the wallet owns on this
 * market. The scan that backs useOwnerMarketPortfolios is the SAME one
 * PositionRow's useUserAccount already triggers, so this adds no RPC.
 */
const ThisMarketPositions: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const infos = useOwnerMarketPortfolios();
  // Only portfolios that actually HOLD a position get a row. A flat (size-0)
  // account — e.g. a closed isolated leg not yet rent-reclaimed — must not
  // render a phantom "SHORT 0" row; the single-portfolio path already hides a
  // flat account behind its empty state, and the multi view matches that by
  // filtering here. (#2560 review M1.)
  const active = useMemo(() => infos.filter((i) => i.account.positionSize !== 0n), [infos]);
  // The true cross/primary account is always the lowest-pubkey portfolio (infos
  // is base58-sorted), whether or not it currently holds a position.
  const primaryPk = infos.length > 0 ? infos[0].pubkey : undefined;
  const soleActiveIsPrimary =
    active.length === 1 && !!active[0].pubkey && !!primaryPk && active[0].pubkey.equals(primaryPk);
  // Common case — no position, or the one position is in the primary (cross)
  // account — keeps today's single-row UI (including the NFT-wrap and empty
  // states), byte-identical. Otherwise (2+ positions, or a lone position living
  // in an isolated account) render the multi-row table.
  if (active.length === 0 || soleActiveIsPrimary) return <PositionRow slabAddress={slabAddress} />;
  return <MultiPositionTable slabAddress={slabAddress} infos={active} primaryPubkey={primaryPk} />;
};

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
          <ThisMarketPositions slabAddress={slabAddress} />
        </RenderProfiler>
        <OtherMarketPositions currentSlab={slabAddress} />
      </div>
      <TradeHistory slabAddress={slabAddress} />
    </DockTabs>
  );
};

export const PositionsDock = memo(PositionsDockInner);
