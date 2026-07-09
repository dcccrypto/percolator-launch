"use client";

/**
 * Cross-market positions for the trade page's dock: every open position the
 * wallet holds on OTHER markets, so a trader watching one chart never has to
 * navigate away (and wait for a full trade-page load) just to monitor or
 * close a position elsewhere. The current market's own position stays in the
 * dock's existing PositionRow above — pinned first and visually its own
 * section; these rows render under an "other markets" divider.
 *
 * Data comes from usePortfolio (wallet-wide scan, 30s poll + refresh on
 * close) with the mark, PnL and ROE re-computed per live tick off the shared
 * WS price store — the same math chain as PositionRow itself:
 * computeMarkPnlCollateral(computeMarkPnl(...)) for collateral-unit PnL and
 * computePnlPercent against computePositionInitialMargin for ROE.
 *
 * Close mounts a SlabProvider for THAT market on demand — only while the
 * modal is open (useClosePosition needs slab context) — so this list never
 * pays N providers' RPC cost for rows the user isn't closing.
 */

import { FC, memo, useCallback, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { subscribeSlab, getSnapshot } from "@/lib/priceStore/priceStore";
import { usePortfolio, type PortfolioPosition } from "@/hooks/usePortfolio";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { SlabProvider } from "@/components/providers/SlabProvider";
import { ClosePositionModal } from "./ClosePositionModal";
import { getEntryPrice, clearEntryPrice } from "@/lib/entry-price";
import {
  computeMarkPnl,
  computeMarkPnlCollateral,
  computePnlPercent,
  computePositionInitialMargin,
} from "@/lib/trading";
import {
  formatTokenAmount,
  formatUsdPriceE6,
  formatLiqPrice,
  formatPnl,
  formatPercent,
} from "@/lib/format";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockPortfolioPositions } from "@/lib/mock-trade-data";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** On-demand close flow — SlabProvider mounted only while the modal is open
 *  (useClosePosition needs slab context; a provider per visible row would
 *  multiply RPC polling by the number of open markets). */
const CloseFlow: FC<{
  pos: PortfolioPosition;
  markE6: bigint;
  priceUsd: number | null;
  symbol: string;
  decimals: number;
  onDone: (closed: boolean) => void;
}> = ({ pos, markE6, priceUsd, symbol, decimals, onDone }) => {
  const { closePosition, loading } = useClosePosition(pos.slabAddress);
  // Same H6/H7 staleness protections as the dock's own PositionRow: a close
  // on an oracle-stale or engine-stale market reverts on-chain — block the
  // modal's Confirm instead of letting the user burn a failed tx. Both hooks
  // read THIS market's freshness via the on-demand SlabProvider above.
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const { engineStale } = useEngineFreshness();
  // Mock slabs have no real oracle/engine to be "fresh" — exempt them like
  // PositionRow's own `!mockMode &&` prefix, so local mock testing isn't
  // permanently blocked.
  const mockExempt = isMockMode() && isMockSlab(pos.slabAddress);
  const oracleStale =
    !mockExempt &&
    (oracleLevel === "unavailable" ||
      (oracleReady && oracleLevel === "stale" && (oracleMode === "admin" || oracleMode === "hyperp" || oracleMode === "keeper")));
  const posSize = pos.account?.positionSize ?? 0n;
  return (
    <ClosePositionModal
      positionSize={posSize}
      entryPrice={pos.effectiveEntryPrice}
      currentPrice={markE6}
      capital={pos.account?.capital ?? 0n}
      symbol={symbol}
      collateralSymbol="USDC"
      decimals={decimals}
      priceUsd={priceUsd}
      isLong={posSize > 0n}
      loading={loading}
      oracleStale={oracleStale || (!mockExempt && engineStale)}
      onConfirm={async (percent) => {
        try {
          await closePosition(percent);
          if (percent === 100) {
            clearEntryPrice(pos.slabAddress, pos.idx, pos.account?.owner?.toBase58?.() ?? "");
          }
          onDone(true);
        } catch {
          /* keep the modal open; the tx error is surfaced by the hook */
        }
      }}
      onCancel={() => onDone(false)}
    />
  );
};

/** One other-market row. Isolated + memoized like the dock's own PositionRow:
 *  the live price-store subscription lives here, so a tick re-renders only
 *  this leaf, never the table shell or sibling rows. */
const OtherMarketRow: FC<{
  pos: PortfolioPosition;
  decimals: number;
  onClosed: () => void;
}> = memo(function OtherMarketRow({ pos, decimals, onClosed }) {
  const [showClose, setShowClose] = useState(false);

  const subscribe = useCallback((cb: () => void) => subscribeSlab(pos.slabAddress, cb), [pos.slabAddress]);
  const getSnap = useCallback(() => getSnapshot(pos.slabAddress).priceE6, [pos.slabAddress]);
  const livePriceE6 = useSyncExternalStore(subscribe, getSnap, () => null);

  const account = pos.account;
  const posSize = account?.positionSize ?? 0n;
  const isLong = posSize > 0n;
  // Entry: the hook's effectiveEntryPrice already resolves on-chain price →
  // client cache → PnL-derived estimate; re-check the cache here only as a
  // defensive fallback for a zero value.
  const entryE6 = pos.effectiveEntryPrice > 0n
    ? pos.effectiveEntryPrice
    : getEntryPrice(pos.slabAddress, pos.idx, account?.owner?.toBase58?.() ?? "");
  const markE6 = livePriceE6 != null && livePriceE6 > 0n ? livePriceE6 : pos.oraclePriceE6;
  const hasValidMark = markE6 > 0n;

  // Same collateral-unit PnL chain as PositionRow / usePortfolio.
  const pnlTokens = (() => {
    if (!hasValidMark || entryE6 <= 0n) return pos.unrealizedPnl;
    try {
      return computeMarkPnlCollateral(computeMarkPnl(posSize, entryE6, markE6), markE6);
    } catch {
      return pos.unrealizedPnl;
    }
  })();
  const pnlUsdRaw = Number(pnlTokens) / 10 ** decimals;
  const pnlUsd = Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = (() => {
    try {
      const im = computePositionInitialMargin(posSize, entryE6, pos.initialMarginBps);
      if (im > 0n) return computePnlPercent(pnlTokens, im);
      const capital = account?.capital ?? 0n;
      return capital > 0n ? computePnlPercent(pnlTokens, capital) : pos.pnlPercent;
    } catch {
      return pos.pnlPercent;
    }
  })();

  const symbol = pos.symbol ?? `${pos.slabAddress.slice(0, 6)}…`;
  const displaySymbol = symbol.replace(/-PERP$/i, "");
  const liqPriceE6 = pos.liquidationPriceE6;
  const liqUnliquidatable = liqPriceE6 <= 0n && entryE6 > 0n && posSize !== 0n;
  const pnlColor = pnlTokens === 0n ? "text-[var(--text-muted)]" : pnlTokens > 0n ? "text-[var(--long)]" : "text-[var(--short)]";
  const roeColor = roe === 0 ? "text-[var(--text-muted)]" : roe > 0 ? "text-[var(--long)]" : "text-[var(--short)]";
  const livePriceUsd = getSnapshot(pos.slabAddress).priceUsd ?? (hasValidMark ? Number(markE6) / 1e6 : null);

  return (
    <>
      <tr className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
        <td className="whitespace-nowrap px-4 py-2.5 text-left">
          {/* Market cell links to the market — the rest of the row stays
              inert so Close never triggers a navigation. */}
          <Link
            href={`/trade/${pos.slabAddress}`}
            className="text-[11px] font-medium text-[var(--text)] transition-colors hover:text-[var(--accent)]"
          >
            {displaySymbol}/USD ↗
          </Link>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-left">
          <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase ${isLong ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"}`}>
            {isLong ? "LONG" : "SHORT"}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          <span className="text-[var(--text)]">{formatTokenAmount(abs(posSize), decimals)}</span>
          <span className="ml-1 text-[var(--text-secondary)]">{displaySymbol}</span>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {entryE6 > 0n ? formatUsdPriceE6(entryE6) : "--"}
        </td>
        <td className={`whitespace-nowrap px-3 py-2.5 text-right ${hasValidMark ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {hasValidMark ? formatUsdPriceE6(markE6) : "--"}
        </td>
        <td
          className="whitespace-nowrap px-3 py-2.5 text-right font-medium text-[var(--text-secondary)]"
          style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
          title={liqUnliquidatable ? "No liquidation price — collateral exceeds position notional; cannot be liquidated by price" : undefined}
        >
          {formatLiqPrice(liqPriceE6, { hasPosition: liqUnliquidatable })}
        </td>
        <td className={`whitespace-nowrap px-3 py-2.5 text-right ${hasValidMark ? pnlColor : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          {hasValidMark ? (
            <>
              <div>{formatPnl(pnlTokens, decimals)} USDC</div>
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
          {pos.nftWrapped ? (
            <span
              title="This position is wrapped in a Position NFT. Burn the NFT on its market's trade page to unwrap it, then close."
              className="inline-block cursor-help rounded-none border border-[var(--accent)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--accent)]"
            >
              🎫 Wrapped
            </span>
          ) : (
            <button
              onClick={() => setShowClose(true)}
              disabled={!hasValidMark}
              title={!hasValidMark ? "Waiting for price data…" : undefined}
              className="rounded-none border border-[var(--short)]/30 px-3 py-1 text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 hover:border-[var(--short)]/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Close
            </button>
          )}
        </td>
      </tr>
      {showClose && (
        <tr>
          <td colSpan={9} className="p-0">
            <SlabProvider slabAddress={pos.slabAddress}>
              <CloseFlow
                pos={pos}
                markE6={markE6}
                priceUsd={livePriceUsd}
                symbol={displaySymbol}
                decimals={decimals}
                onDone={(closed) => {
                  setShowClose(false);
                  if (closed) onClosed();
                }}
              />
            </SlabProvider>
          </td>
        </tr>
      )}
    </>
  );
});

/**
 * The "other markets" section of the dock's Positions tab. Renders nothing
 * when the wallet holds no open positions beyond the current market.
 */
const OtherMarketPositionsInner: FC<{ currentSlab: string }> = ({ currentSlab }) => {
  // Hook-gated, not just render-gated (the same review point 6749ba6 fixed on
  // the header strip): usePortfolio's full scan cost — market discovery +
  // batched account reads on a 30s interval — must not run for a wallet that
  // can't have positions. `enabled=false` short-circuits both the fetch
  // effect and the auto-refresh interval.
  const { connected: walletConnected } = useWalletCompat();
  const portfolio = usePortfolio(walletConnected);
  const mockMode = isMockMode();
  // Mock book only when DISCONNECTED (same gate as the portfolio page and the
  // header strip) — a connected wallet in ?mock=1 must never see synthetic
  // positions mixed into a real trade page.
  const positions = mockMode && !walletConnected ? getMockPortfolioPositions() : portfolio.positions;

  // Largest exposure first — same notional ordering as the header positions
  // strip, and sorted on the poll's oracle price so rows don't reshuffle on
  // live ticks. (filter() copies, so sort() never mutates hook state.)
  const notionalOf = (pos: PortfolioPosition): bigint => {
    const size = pos.account?.positionSize ?? 0n;
    const a = size < 0n ? -size : size;
    return pos.oraclePriceE6 > 0n ? (a * pos.oraclePriceE6) / 1_000_000n : a;
  };
  const others = positions
    .filter((pos) => pos.slabAddress !== currentSlab && (pos.account?.positionSize ?? 0n) !== 0n)
    .sort((a, b) => (notionalOf(b) > notionalOf(a) ? 1 : notionalOf(b) < notionalOf(a) ? -1 : 0));
  const tokenMetaMap = useMultiTokenMeta(others.map((pos) => pos.collateralMint));

  if (others.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 border-t border-[var(--border)]/40 px-4 pb-1 pt-3">
        <span className="text-[9px] font-medium uppercase tracking-[0.25em] text-[var(--text-secondary)]">
          // other markets
        </span>
        <span className="text-[9px] text-[var(--text-secondary)]">
          {others.length} open position{others.length === 1 ? "" : "s"}
        </span>
      </div>
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
            {others.map((pos) => (
              <OtherMarketRow
                key={`${pos.slabAddress}-${pos.idx}`}
                pos={pos}
                decimals={tokenMetaMap.get(pos.collateralMint.toBase58())?.decimals ?? 6}
                onClosed={portfolio.refresh}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const OtherMarketPositions = memo(OtherMarketPositionsInner);
