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

import { FC, memo, useMemo, useState } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useEngineState } from "@/hooks/useEngineState";
import { AccountKind } from "@percolatorct/sdk";
import {
  formatTokenAmount,
  formatUsdPriceE6,
  formatLiqPrice,
  formatPnl,
  formatPercent,
} from "@/lib/format";
import {
  computeMarkPnl,
  computeLiqPrice,
  computePnlPercent,
  estimateEntryFromPnl,
  computeMarkPnlCollateral,
  computePositionInitialMargin,
} from "@/lib/trading";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { ClosePositionModal } from "./ClosePositionModal";
import { OtherMarketPositions } from "./OtherMarketPositions";
import { WarmupProgress } from "./WarmupProgress";
import { TradeHistory } from "./TradeHistory";
import { InfoIcon } from "@/components/ui/Tooltip";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { usePriceFlash } from "@/hooks/usePriceFlash";
import { getEntryPrice, clearEntryPrice } from "@/lib/entry-price";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { isSentinelValue } from "@/lib/health";
import { RenderProfiler } from "@/components/dev/RenderProfiler";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function EmptyState({ subtitle }: { subtitle: string }) {
  return (
    <div className="py-10 text-center">
      <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border)]/30">
        <svg className="h-4 w-4 text-[var(--text-dim)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
        </svg>
      </div>
      <p className="text-[11px] font-medium text-[var(--text)]">No open positions</p>
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
  const config = useMarketConfig();
  const { accounts, config: mktConfig, params } = useSlabState();
  const { engine, insuranceBalance } = useEngineState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const decimals = tokenMeta?.decimals ?? 6;
  // T3-dd: `symbol` sometimes already carries a "-PERP" suffix from the
  // market registry (e.g. "SOL-PERP") — appending "/USD" on top of that
  // rendered "SOL-PERP/USD". Strip it once, just for the Market column label
  // below; every other `symbol` usage in this row (token amounts, tooltips)
  // is unaffected.
  const marketDisplaySymbol = symbol.replace(/-PERP$/i, "");

  const { closePosition, loading: closeLoading, error: closeError, prewarmClose } = useClosePosition(slabAddress);
  // Called unconditionally, before the `!activeInfo` early return below, per
  // rules of hooks — mirrors MarketInfoBar's MarkPrice / MarketBookCard's
  // Oracle cell (same shared hook, see hooks/usePriceFlash.ts).
  const markFlash = usePriceFlash(livePriceE6 ?? null);
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  // H7: "keeper" added to the mode set — this gate previously only fired for
  // admin/hyperp markets, so a stale keeper-priced market (all 5 live
  // playground markets) never blocked closing.
  const oracleStale = !mockMode && (oracleUnavailable || (oracleReady && oracleLevel === "stale" && (oracleMode === "admin" || oracleMode === "hyperp" || oracleMode === "keeper")));
  // H6: engine accrue-staleness — distinct from the oracle-push freshness
  // above. A market can look perfectly fresh here (keeper still pushing
  // prices) while the ENGINE hasn't accrued in ~500 slots, cliff-dead and
  // permanently reverting every close until a maintainer re-seeds it. See
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

  if (!activeInfo) {
    if (!userAccount) return <EmptyState subtitle="Connect your wallet and deposit collateral to start trading." />;
    return <EmptyState subtitle="Use the order ticket to open a position." />;
  }
  const { account } = activeInfo;

  const isLong = account.positionSize > 0n;
  const absPosition = abs(account.positionSize);
  const onChainPriceE6 = config ? sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert)) : null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;
  const rawEntryPrice = account.entryPrice;
  // BUG 10 fix: scope the cache lookup to this account's own wallet (its
  // on-chain `owner`) — the unscoped key collapsed to one slot per market
  // shared by every wallet that traded it in this browser (v17 accountIdx is
  // always 0), so switching wallets showed the previous wallet's entry price.
  const savedEntryPrice = rawEntryPrice > 0n ? 0n : getEntryPrice(slabAddress, activeInfo.idx, account.owner.toBase58());
  const resolvedEntryPrice = rawEntryPrice > 0n ? rawEntryPrice : (savedEntryPrice > 0n ? savedEntryPrice : 0n);
  // No on-chain entry price (v17) and no local cache — this is the ONLY path
  // a Position NFT received via transfer ever takes (the recipient's browser
  // never ran the trade that opened it, so getEntryPrice() has nothing
  // saved). Derive an effective entry from the position's on-chain
  // unrealized PnL instead of naively substituting the mark price, which
  // silently implies zero PnL and cascades into a liq price clamped to
  // "N/A" below. See estimateEntryFromPnl.
  const entryPriceE6 = resolvedEntryPrice > 0n
    ? resolvedEntryPrice
    : estimateEntryFromPnl(account.positionSize, account.pnl, currentPriceE6);
  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const hasValidMark = currentPriceE6 > 0n;

  // Native "coin-margined" scale (see computeMarkPnl's on-chain-formula doc
  // comment) — NOT yet a collateral/USDC-denominated amount. Converted below
  // via computeMarkPnlCollateral before it's shown or compared against
  // anything collateral-scaled (capital, margin, vault balance). The stale
  // on-chain `account.pnl` fallback (NFT-transfer path, no cached entry) is
  // in this SAME native scale — estimateEntryFromPnl's whole premise is that
  // computeMarkPnl(size, derivedEntry, mark) === account.pnl — so one
  // conversion below covers both branches.
  const pnlNative = hasValidMark
    ? (resolvedEntryPrice > 0n
        ? computeMarkPnl(account.positionSize, resolvedEntryPrice, currentPriceE6)
        : (isSentinelValue(account.pnl) ? 0n : account.pnl))
    : 0n;
  // Collateral-equivalent PnL — the single number this row's USDC line, USD
  // line, ROE, and pool-cap check all derive from, so they can't disagree
  // with each other (or with ChartPnlBadge, which reaches the same figure
  // via an equivalent float `* priceUsd` conversion).
  const pnlTokens = hasValidMark ? computeMarkPnlCollateral(pnlNative, currentPriceE6) : 0n;
  // sim-USDC is $1-pegged collateral (see PLAYGROUND.md) — the collateral
  // amount above already IS the dollar figure, just formatted differently.
  const pnlUsdRaw = hasValidMark ? Number(pnlTokens) / 10 ** decimals : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  // The position's own locked initial margin (its entry notional at the
  // market's initial-margin requirement) — NOT total account capital — is
  // the correct ROE basis; a losing position must show a negative ROE, not
  // a near-zero one from mixing native-scale PnL with collateral-scale
  // capital. computePnlPercent throws when pnlTokens*10000/margin overflows
  // MAX_SAFE_INTEGER (extreme dust-margin position); fall back to 0 so an
  // outlier position can't blank the whole panel (mirrors the
  // slippageBoundE6 guard in OrderTicket.tsx).
  const positionInitialMargin = computePositionInitialMargin(account.positionSize, entryPriceE6, initialMarginBps);
  let roe = 0;
  try {
    roe = hasValidMark && positionInitialMargin > 0n ? computePnlPercent(pnlTokens, positionInitialMargin) : 0;
  } catch {
    roe = 0;
  }

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
  const payableCapacity = (engine?.vault ?? 0n) + (insuranceBalance ?? 0n);
  const pnlIsCapped = hasValidMark && pnlTokens > 0n && payableCapacity > 0n && pnlTokens > payableCapacity;

  const liqPriceE6 = computeLiqPrice(entryPriceE6, account.capital, account.positionSize, maintenanceBps);
  // Long-side clamp: liq at/below $0 with a live position = cannot be
  // liquidated by price (excess collateral) — formatLiqPrice renders "∞".
  const liqUnliquidatable = liqPriceE6 <= 0n && entryPriceE6 > 0n && account.positionSize !== 0n;
  const liqPriceColor = (() => {
    if (liqUnliquidatable) return "text-[var(--text-secondary)]";
    if (liqPriceE6 <= 0n) return "text-[var(--text-secondary)]";
    if (!hasValidMark || currentPriceE6 <= 0n) return "text-[var(--warning)]";
    const distPct = Math.abs(Number(currentPriceE6) - Number(liqPriceE6)) / Number(currentPriceE6);
    if (distPct < 0.05) return "text-[var(--short)]";
    if (distPct < 0.10) return "text-[var(--warning)]";
    return "text-[var(--text-secondary)]";
  })();
  const pnlColor = pnlTokens === 0n ? "text-[var(--text-muted)]" : pnlTokens > 0n ? "text-[var(--long)]" : "text-[var(--short)]";
  const roeColor = roe === 0 ? "text-[var(--text-muted)]" : roe > 0 ? "text-[var(--long)]" : "text-[var(--short)]";

  const handleConfirmClose = async (percent: number) => {
    try {
      await closePosition(percent);
      if (percent === 100) clearEntryPrice(slabAddress, activeInfo.idx, account.owner.toBase58());
      setShowCloseModal(false);
    } catch {
      // error surfaced via hook state below
    }
  };

  return (
    <div>
      {lpUnderfunded && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">LP Underfunded</span>
        </div>
      )}
      {/* H6: engine-stale takes priority over the generic oracle-stale copy
          when it's specifically the engine accrue guard that tripped — tells
          the user this needs a re-seed, not just "wait a moment". */}
      {engineStale && !oracleStale && (
        <div className="border-b border-[var(--warning)]/20 bg-[var(--warning)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">Market Crank Behind — Trading Paused</span>
        </div>
      )}
      {isNftWrapped && (
        <div className="border-b border-[var(--accent)]/20 bg-[var(--accent)]/5 px-4 py-1.5 text-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--accent)]">
            🎫 Wrapped in Position NFT — burn it in the Position NFT panel to unwrap &amp; close
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
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Entry</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Mark</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Liq. Price</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">PnL</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">ROE%</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
              <td className="whitespace-nowrap px-4 py-2.5 text-left"><span className="text-[11px] font-medium text-[var(--text)]">{marketDisplaySymbol}/USD</span></td>
              <td className="whitespace-nowrap px-3 py-2.5 text-left">
                <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${isLong ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"}`}>
                  {isLong ? "LONG" : "SHORT"}
                </span>
                {isNftWrapped && (
                  <span className="ml-1 inline-block rounded-sm bg-[var(--accent)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--accent)]" title="This position is wrapped in a Position NFT you hold.">
                    🎫 NFT
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                <span className="text-[var(--text)]">{formatTokenAmount(absPosition, decimals)}</span>
                <span className="ml-1 text-[var(--text-secondary)]">{symbol}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {formatUsdPriceE6(entryPriceE6)}
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
                className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${liqPriceColor}`}
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                title={liqUnliquidatable ? "No liquidation price — collateral exceeds position notional; cannot be liquidated by price" : undefined}
              >
                {formatLiqPrice(liqPriceE6, { hasPosition: liqUnliquidatable })}
              </td>
              <td className={`whitespace-nowrap px-3 py-2.5 text-right ${hasValidMark ? pnlColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {hasValidMark ? (
                  <>
                    <div className="flex items-center justify-end gap-1">
                      {formatPnl(pnlTokens, decimals)} {collateralSymbol}
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
                        {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}${Math.abs(pnlUsd).toFixed(2)}
                      </div>
                    )}
                  </>
                ) : (
                  <span>--</span>
                )}
              </td>
              <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium ${hasValidMark ? roeColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {hasValidMark ? formatPercent(roe) : "--"}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">
                {isNftWrapped ? (
                  <span
                    title="This position is wrapped in a Position NFT. Burn the NFT in the Position NFT panel to unwrap it, then close."
                    className="inline-block cursor-help rounded-none border border-[var(--accent)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--accent)]"
                  >
                    🎫 Wrapped
                  </span>
                ) : (
                  <button
                    // prewarmClose: start the fresh position read + tx prewarms
                    // the moment the modal opens, so the confirm click reaches
                    // the wallet popup with zero blocking round-trips.
                    onClick={() => { prewarmClose(); setShowCloseModal(true); }}
                    disabled={closeLoading || lpUnderfunded || !hasValidMark || engineStale}
                    title={!hasValidMark ? "Waiting for price data…" : engineStale ? "Market crank behind — trading paused. This market needs a re-seed before closing works." : undefined}
                    className="rounded-none border border-[var(--short)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 hover:border-[var(--short)]/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Close
                  </button>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2">
        <WarmupProgress slabAddress={slabAddress} accountIdx={activeInfo.idx} />
      </div>
      {closeError && (
        <div className="mx-4 mb-3 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{closeError}</p>
        </div>
      )}
      {showCloseModal && (
        <ClosePositionModal
          positionSize={account.positionSize}
          entryPrice={entryPriceE6}
          currentPrice={currentPriceE6}
          capital={account.capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          tradingFeeBps={params?.tradingFeeBps}
          // Defense-in-depth: the row-level Close button above is already
          // disabled on engineStale (with its own correctly-labeled title),
          // but if the modal is somehow already open when engine-staleness
          // is detected, keep its Confirm button blocked too.
          oracleStale={closeBlockedByStaleness}
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
        <OtherMarketPositions currentSlab={slabAddress} />
      </div>
      <TradeHistory slabAddress={slabAddress} />
    </DockTabs>
  );
};

export const PositionsDock = memo(PositionsDockInner);
