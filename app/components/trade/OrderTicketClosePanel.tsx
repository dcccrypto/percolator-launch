"use client";

import { catchUpAvailableLine } from "@/lib/limits/catchup-estimate";
import { LastCloseTxLink } from "@/components/trade/LastCloseTxLink";
import { useSlabState } from "@/components/providers/SlabProvider";
import { onChainMarkE6 } from "@/lib/position-pnl";
import { FC, useEffect, useRef } from "react";
import type { PublicKey } from "@solana/web3.js";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useLivePrice } from "@/hooks/useLivePrice";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import { NFT_MENU_COPY } from "@/components/trade/PositionNftMenu";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { STALE_SETTLE_COPY, marketResolvedV22 } from "@/lib/v22/stale-resolve";

export interface OrderTicketClosePanelProps {
  slabAddress: string;
  /** Signed position size (base units); 0n = nothing to close. */
  positionSize: bigint;
  /** v2.2 lot exponent (position in lots, prices per lot); omitted = no lots. */
  lotExp?: number;
  /** GH#2707: the wallet's portfolio scan has not answered yet, so a 0n
   *  `positionSize` is "unknown", not "no position" — render loading. */
  accountPending?: boolean;
  /** Resolved entry price (E6), or 0n when UNKNOWN (#2660) — never the mark placeholder. */
  entryPriceE6: bigint;
  /** #3534: the risk entry the close preview's balance-after is valued from. Omitted = `entryPriceE6`. */
  riskEntryPriceE6?: bigint;
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
  /** v2.2 band: the close the stale price would favour is refused (104) while the price walks to its target (mirrors PositionsDock). */
  bandCloseHold?: boolean;
  /** Estimated catch-up wait (ms) for the band market; null/absent = "usually a few minutes". */
  catchUpMs?: number | null;
  /** Oracle unavailable/stale (already mock-mode aware) — blocks the close. */
  oracleBlocked: boolean;
  /** Price older than 60 s but the chain would still accept the close: show a calm note, do not block. */
  oraclePriceBehind?: boolean;
  /** Seconds since the last price push, for the note shown with `oraclePriceBehind`. */
  priceAgeSecs?: number;
  /** ADL state unknown: withhold the raw-size preview (see ClosePositionFormProps). */
  previewUnavailable?: boolean;
  /** The portfolio account `positionSize` was read from; Close acts on exactly this one (#3301). */
  portfolioPk?: PublicKey;
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
  lotExp = 0,
  accountPending = false,
  entryPriceE6,
  riskEntryPriceE6,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  tradingFeeBps,
  maxFillAbs,
  lpUnderfunded,
  engineStale: engineStaleProp,
  bandCloseHold = false,
  catchUpMs = null,
  oracleBlocked,
  oraclePriceBehind = false,
  priceAgeSecs = 0,
  previewUnavailable = false,
  portfolioPk,
  onClosed,
}) => {
  const { closePosition, loading, error, prewarmClose } = useClosePosition(slabAddress);
  // #3301: the account the ticket's position size was read from.
  const closeTarget = portfolioPk ? { portfolioPk } : undefined;
  const { priceE6, priceUsd } = useLivePrice();
  // What the chain settles a close at: the stored mark, not the live-store price (matters when the price is behind).
  const { config: slabConfig, wrapperConfigV17, raw: marketRaw } = useSlabState();
  const settleMarkE6 = onChainMarkE6(slabConfig, wrapperConfigV17 !== null);

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
    if (hasPosition) prewarmRef.current(closeTarget);
  }, [hasPosition, slabAddress]);

  const handleConfirm = async (percent: number) => {
    try {
      // With no bound account the call keeps its one-argument shape (percent only).
      await (closeTarget ? closePosition(percent, closeTarget) : closePosition(percent));
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
        <LastCloseTxLink slabAddress={slabAddress} className="mt-3" />
      </div>
    );
  }

  // AUD-FC-A2: on a RESOLVED market a normal close builds a trade the program refuses (21, then 14: "Invalid engine configuration").
  // The way out is CloseResolved, offered by the "Close and withdraw" button of the settled notice right above the ticket
  // (components/trade/StaleSettleNotice.tsx, hooks/useStaleResolve.ts); the close form is not offered here.
  if (isDevnetV22Enabled() && marketResolvedV22(marketRaw)) {
    return (
      <div data-testid="close-panel-settled" role="status" className="rounded-none border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-6 text-center">
        <p className="text-[12px] font-medium text-[var(--text)]">{STALE_SETTLE_COPY.settledLine}</p>
        <p className="mx-auto mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-[var(--text-secondary)]">
          Use &ldquo;{STALE_SETTLE_COPY.settledButton}&rdquo; above.
        </p>
      </div>
    );
  }

  // The engine lag or the band hold: either way the close waits on the price catching up.
  const engineStale = engineStaleProp || bandCloseHold;
  // Gates that block the close beyond the form's own loading/oracleStale: no
  // live mark (can't preview or fill), engine catching up past the app's own repair, or an LP with no
  // capital. Mirrors the labels/tooltips the old button used.
  const submitDisabled = !hasValidMark || engineStale || lpUnderfunded;
  const submitDisabledLabel = !hasValidMark ? "Awaiting Price…" : engineStale ? "Waiting for prices…" : undefined;
  const submitTitle = !hasValidMark
    ? "Waiting for price data…"
    : engineStale
      ? catchUpAvailableLine(catchUpMs, "close")
      : lpUnderfunded
        ? "The LP has no capital, so a close cannot fill."
        : undefined;

  return (
    <div className="min-w-0">
      <ClosePositionForm
        variant="inline"
        positionSize={positionSize}
        lotExp={lotExp}
        entryPrice={entryPriceE6}
        riskEntryPrice={riskEntryPriceE6}
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
        oraclePriceBehind={oraclePriceBehind}
        engineCatchingUp={engineStale}
        catchUpMs={catchUpMs}
        priceAgeSecs={priceAgeSecs}
        settleMarkE6={settleMarkE6}
        error={error}
        maxFillAbs={maxFillAbs}
        previewUnavailable={previewUnavailable}
        onConfirm={handleConfirm}
        submitDisabled={submitDisabled}
        submitDisabledLabel={submitDisabledLabel}
        submitTitle={submitTitle}
        onSubmitIntent={() => prewarmRef.current(closeTarget)}
      />
      {/* SC-1: a partial close leaves the position open, so the empty-state link never shows; show it here. */}
      <LastCloseTxLink slabAddress={slabAddress} className="mt-2" />
    </div>
  );
};
