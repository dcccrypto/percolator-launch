"use client";

import { FC, useEffect, useRef } from "react";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useLivePrice } from "@/hooks/useLivePrice";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import { NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

export interface OrderTicketClosePanelProps {
  slabAddress: string;
  /** Signed position size (base units); 0n = nothing to close. */
  positionSize: bigint;
  /** GH#2707: the wallet's portfolio scan has not answered yet, so a 0n
   *  `positionSize` is "unknown", not "no position" — render loading. */
  accountPending?: boolean;
  /** Resolved entry price (E6), or 0n when UNKNOWN (#2660) — never the mark placeholder. */
  entryPriceE6: bigint;
  capital: bigint;
  symbol: string;
  collateralSymbol: string;
  decimals: number;
  tradingFeeBps?: bigint;
  /** Per-fill cap (matcherCaps.maxFillAbs), surfaced when a close batches. */
  maxFillAbs: bigint | null;
  /** The market's LP has no capital: a close cannot fill (mirrors PositionsDock). */
  lpUnderfunded: boolean;
  /** Engine lag beyond the app's own catch-up (UX WP-2 SH-3; mirrors PositionsDock); clears itself. */
  engineStale: boolean;
  /** Oracle unavailable/stale (already mock-mode aware) — blocks the close. */
  oracleBlocked: boolean;
  /** ADL state unknown: withhold the raw-size preview (see ClosePositionFormProps). */
  previewUnavailable?: boolean;
  /** Called after a SUCCESSFUL close with the percent that was closed. */
  onClosed: (percent: number) => void;
}

/**
 * Close mode of the order ticket (GH#2651). Renders the FULL close form inline
 * (slider, %-presets, Est. PnL / Trading Fee / Est. Account Balance After) — the same shared
 * ClosePositionForm the modal uses — so closing the position you're looking at
 * needs no popup and matches the modal's detail.
 *
 * A separate component, mounted ONLY in Close mode, for two reasons:
 *  - `OrderTicket` deliberately does not subscribe to the live price (see its
 *    file header); this panel needs a REACTIVE mark for PnL / Est. receive, and
 *    must not drag that subscription into the open form.
 *  - `useClosePosition` (useTrade + slab + user-account subscriptions) is not
 *    free, so it's only mounted while the trader is actually closing.
 *
 * All close logic stays in `useClosePosition` (fresh on-chain size read, so a
 * stale UI size can't over-close into an opposite position); this component
 * only decides WHEN closing is allowed, with the same gates PositionsDock /
 * PositionPanel apply.
 */
export const OrderTicketClosePanel: FC<OrderTicketClosePanelProps> = ({
  slabAddress,
  positionSize,
  accountPending = false,
  entryPriceE6,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  tradingFeeBps,
  maxFillAbs,
  lpUnderfunded,
  engineStale,
  oracleBlocked,
  previewUnavailable = false,
  onClosed,
}) => {
  const { closePosition, loading, error, prewarmClose } = useClosePosition(slabAddress);
  const { priceE6, priceUsd } = useLivePrice();

  const currentPriceE6 = priceE6 ?? 0n;
  const hasValidMark = currentPriceE6 > 0n;
  const hasPosition = positionSize !== 0n;
  const isLong = positionSize > 0n;

  // `positionSize` comes from useUserAccount, which only sees portfolios the
  // wallet OWNS. Wrapping a position as a Position NFT moves the portfolio's
  // owner to the NFT escrow, so a wrapped position reads as 0n here even though
  // the dock, /portfolio and the header bar all list it. Look for it (same
  // lookup and gate as PositionsDock) so "No open position" is never shown for
  // a position the wallet still holds through its NFT.
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const wrapped = useNftWrappedPosition(slabAddress, !hasPosition && !accountPending && !mockMode);
  const wrappedSize = wrapped?.account.positionSize ?? 0n;

  // Warm the fresh-read + trade prewarms once the close form is on screen, so
  // the first "Close" click reaches the wallet popup with no blocking RPC.
  // ONCE per mount/market — not on every `prewarmClose` identity change: its
  // deps include SlabProvider's `programId`, which is re-set from each slab
  // update's `owner` object, so keying the effect on it re-ran the prewarm
  // (a portfolio read + trade-account resolve) on every crank while the tab
  // was open. The prewarmed read is only consumed within 4s
  // (FRESH_READ_TTL_MS), so the button also re-warms on hover/focus — the
  // same moment the old "Close Position" button warmed it.
  const prewarmRef = useRef(prewarmClose);
  prewarmRef.current = prewarmClose;
  useEffect(() => {
    if (hasPosition) prewarmRef.current();
  }, [hasPosition, slabAddress]);

  const handleConfirm = async (percent: number) => {
    try {
      await closePosition(percent);
      onClosed(percent);
    } catch {
      // Surfaced through `error`, rendered inside the form.
    }
  };

  if (!hasPosition && accountPending) {
    return (
      <div
        data-testid="close-panel-loading"
        role="status"
        className="rounded-none border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-8 text-center"
      >
        <p className="text-[12px] font-medium text-[var(--text-secondary)]">Loading position…</p>
      </div>
    );
  }

  if (!hasPosition && wrappedSize !== 0n) {
    return (
      <div
        data-testid="close-panel-wrapped"
        className="rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-3 py-8 text-center"
      >
        <p className="text-[12px] font-medium text-[var(--text)]">{NFT_MENU_COPY.closeTabTitle}</p>
        <p className="mx-auto mt-1.5 max-w-[240px] text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {NFT_MENU_COPY.closeTabBody(wrappedSize > 0n ? "long" : "short")}
        </p>
      </div>
    );
  }

  if (!hasPosition) {
    return (
      <div className="rounded-none border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-8 text-center">
        <p className="text-[12px] font-medium text-[var(--text)]">No open position</p>
        <p className="mx-auto mt-1.5 max-w-[240px] text-[11px] leading-relaxed text-[var(--text-secondary)]">
          You have no open position in this market to close. Switch to Open to place a trade.
        </p>
      </div>
    );
  }

  // Gates that block the close beyond the form's own loading/oracleStale: no
  // live mark (can't preview or fill), engine catching up past the app's own repair, or an LP with no
  // capital. Mirrors the labels/tooltips the old button used.
  const submitDisabled = !hasValidMark || engineStale || lpUnderfunded;
  const submitDisabledLabel = !hasValidMark ? "Awaiting Price…" : engineStale ? "Waiting for prices…" : undefined;
  const submitTitle = !hasValidMark
    ? "Waiting for price data…"
    : engineStale
      ? "Prices are catching up. Closing resumes once the market has caught up."
      : lpUnderfunded
        ? "The LP has no capital, so a close cannot fill."
        : undefined;

  return (
    <div className="min-w-0">
      <ClosePositionForm
        variant="inline"
        positionSize={positionSize}
        entryPrice={entryPriceE6}
        currentPrice={currentPriceE6}
        capital={capital}
        symbol={symbol}
        collateralSymbol={collateralSymbol}
        decimals={decimals}
        priceUsd={priceUsd}
        isLong={isLong}
        loading={loading}
        tradingFeeBps={tradingFeeBps}
        oracleStale={oracleBlocked}
        error={error}
        maxFillAbs={maxFillAbs}
        previewUnavailable={previewUnavailable}
        onConfirm={handleConfirm}
        submitDisabled={submitDisabled}
        submitDisabledLabel={submitDisabledLabel}
        submitTitle={submitTitle}
        onSubmitIntent={() => prewarmRef.current()}
      />
    </div>
  );
};
