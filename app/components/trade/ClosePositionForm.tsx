"use client";

import { catchUpAvailableLine } from "@/lib/limits/catchup-estimate";
import { priceBehindLine } from "@/lib/oracle-stale-gate";
import { FC, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatTokenAmount } from "@/lib/format";
import { SPREAD_LABEL, feeBpsWithSpread, spreadValueText, type SpreadEstimate } from "@/lib/v22/spread-estimate";
import { formatLotPriceE6, formatLotQ } from "@/lib/v22/lot";
import { busyFeeShareAtoms } from "@/lib/v22/busy-fee";
import { computeMarkPnl, computeMarkPnlLinear, clampClosePercent, UNKNOWN_ENTRY_TOOLTIP } from "@/lib/trading";

/**
 * The body of the close-position UI: position banner, close-amount slider + %
 * presets, the Est. PnL / Trading Fee / Est. Account Balance After preview, and the close
 * button. Shared by:
 *  - ClosePositionModal (`variant="modal"`) — wraps this in a dialog with a
 *    title, an X, and a Cancel button.
 *  - OrderTicketClosePanel (`variant="inline"`) — renders it directly in the
 *    order ticket, so closing looks like the modal without the popup.
 *
 * All close math (PnL/fee/receive) lives here ONCE so the modal and the inline
 * panel can never drift. Pure presentation + a `percent` slider; the actual
 * close is the caller's `onConfirm(percent)` (which reuses useClosePosition).
 */
export interface ClosePositionFormProps {
  positionSize: bigint;
  /**
   * Resolved entry (E6), or 0n when it is UNKNOWN (#2660): v17/v18 store no
   * entry on-chain, and callers pass 0n rather than the mark placeholder.
   * Then the PnL is not "0" — the form shows "unknown entry", PnL "--" and an
   * Est. Account Balance After marked "excl. PnL".
   */
  entryPrice: bigint;
  /**
   * #3534: the entry the balance-after is valued from (`capital + q x (mark - riskEntry)` is the account's equity). Omitted = `entryPrice`.
   * It differs from the display entry (the price paid) in two cases: a fully settled leg (the fill price would take a loss out of a capital
   * that already paid it) and a v2.2 fill (the engine's basis is the booked price; the spread already left capital as a fee, so the balance
   * is valued from the booked price while Est. PnL, from the price paid, is net of it).
   */
  riskEntryPrice?: bigint;
  /**
   * r9 Risk MED: the growth busy-side (utilisation) fee paid when the position was opened, in collateral atoms for the WHOLE position (the
   * saved entry's `busyFeeAtoms`, current record only). It is not in the Entry (#3810), so the net result subtracts the closed part's share
   * and shows it as its own row. null / omitted = unknown.
   */
  busyOpenFeeAtoms?: bigint | null;
  /**
   * This market can charge a busy-side fee at open (a growth market). With the amount unknown a positive net is then neutral and tagged
   * "excl. busy-side fee" (never a green profit that the realised result could contradict). false / omitted = as before.
   */
  busyFeeMayApply?: boolean;
  /**
   * r10 owner decision 1: funding the position has paid so far (collateral atoms, WHOLE position, negative = received): what the chain has
   * already moved since the trade opened plus what has accrued and is not yet settled (lib/funding-flow.ts). It is part of the net result, so
   * the estimate and the realised "Trade result" agree. On a device that did not place the trade it comes from the book rebuilt from chain (the
   * opening fill's funding memo). null = the chain cannot state it (no memo on the opening fill, a read failed): the net then stands but is tagged
   * "excl. funding" (never green). Omitted = the caller does not supply it (no tag, nothing subtracted).
   */
  fundingPaidAtoms?: bigint | null;
  /** r10 (#3817 MED-1): the market may charge holding rent, which no figure here includes: the net is tagged "excl. holding fee" (never green). */
  holdingFeeExcluded?: boolean;
  currentPrice: bigint;
  capital: bigint;
  /** Index asset symbol for position size (e.g. "SOL"). */
  symbol: string;
  /** Collateral symbol for PnL/receive (e.g. "USDC"). Falls back to symbol. */
  collateralSymbol?: string;
  decimals: number;
  priceUsd: number | null;
  /** v2.2 lot exponent (position in lots, prices per lot); omitted = no lots. */
  lotExp?: number;
  isLong: boolean;
  loading: boolean;
  tradingFeeBps?: bigint;
  /**
   * #3726: the fee a close of `closeAbs` is expected to be charged (bps): base + the matcher's requested fee on a fee-channel market.
   * Omitted = `tradingFeeBps` alone. A larger value shows the row as "Trading Fee (est.)", as the confirm screen does for opens.
   */
  closeFeeBpsFor?: (closeAbs: bigint) => bigint;
  /**
   * M7: the matcher's pre-trade spread / price impact for a close of `closeAbs` (`takerBuys` = closing a short), shown for INFORMATION.
   * The close books at the mark; the spread is charged only through the fee channel (already inside the fee estimate where it is on,
   * nothing extra where it is off), so it is never subtracted from the balance preview. Omitted / null = "Not available before the trade".
   */
  spreadEstimateFor?: ((closeAbs: bigint, takerBuys: boolean, takerReducing?: boolean) => SpreadEstimate | null) & {
    /** The quote will not arrive (failed read, no matcher, mock): the net then comes from the base-fee estimate, labelled as excluding the spread. */
    unavailable?: boolean;
  };
  /** Blocks close + shows the oracle-stale warning (matured oracle / no price — what the chain refuses). */
  oracleStale?: boolean;
  /** Price older than 60 s but the chain would accept the close — shows one calm line, never blocks. */
  oraclePriceBehind?: boolean;
  /** Seconds since the last price push (note text). */
  priceAgeSecs?: number;
  /** The stored mark the chain settles at. When the price is behind, the preview is computed from it, not from `currentPrice`. */
  settleMarkE6?: bigint | null;
  /** Blocks close + says the market is catching up (engine lag, not the oracle). */
  engineCatchingUp?: boolean;
  /** Estimated catch-up wait (ms), when the market lets us compute it; absent = "usually a few minutes". */
  catchUpMs?: number | null;
  error?: string | null;
  /** Per-fill cap — a close bigger than this executes as several batch legs. */
  maxFillAbs?: bigint | null;
  /**
   * The ADL state of this market is unknown, so the size the close will act on
   * (the leg's EFFECTIVE size) is unknown and `positionSize` is only raw basis.
   * Withhold the size / PnL / balance preview rather than show raw-size figures;
   * the close itself still re-reads the leg and acts on its effective size.
   */
  previewUnavailable?: boolean;
  onConfirm: (percent: number) => void;
  /** Modal chrome only (title + X + Cancel). Omit for inline. */
  onCancel?: () => void;
  variant?: "modal" | "inline";
  /** Extra block beyond loading/oracleStale (no mark, engine stale, LP underfunded…). */
  submitDisabled?: boolean;
  /** Button label to show when `submitDisabled` (overrides "Close N%"). */
  submitDisabledLabel?: string;
  /** Tooltip explaining why the close is blocked. */
  submitTitle?: string;
  /** Hover/focus on the submit button — lets the caller warm the close's reads. */
  onSubmitIntent?: () => void;
}

/** How long the last good funding figure of the same position is kept while the figure is being read again. After that it is "excl. funding". */
export const FUNDING_HOLD_MS = 20_000;

/**
 * r10 live check: a funding read that fails for a moment (public RPC rate limits) must not flip the dialog to "excl. funding". While `value` is
 * null, the last good value is kept for the SAME position (same side, size and entry: `key`) for up to FUNDING_HOLD_MS. A different position or
 * size never gets it. After the hold, or with nothing good to hold, null stays null.
 */
function useHeldFunding(value: bigint | null | undefined, key: string): bigint | null | undefined {
  const good = useRef<{ key: string; value: bigint } | null>(null);
  const nullSince = useRef<number | null>(null);
  const [, bump] = useState(0);
  const now = Date.now();
  if (typeof value === "bigint") {
    good.current = { key, value };
    nullSince.current = null;
  } else if (value === null) {
    if (nullSince.current === null) nullSince.current = now;
  } else {
    nullSince.current = null; // omitted: the caller does not supply funding
  }
  if (good.current && good.current.key !== key) good.current = null; // another position or size: never reuse
  const holding = value === null && good.current !== null && nullSince.current !== null && now - nullSince.current < FUNDING_HOLD_MS;
  useEffect(() => {
    if (!holding || nullSince.current === null) return;
    const t = setTimeout(() => bump((n) => n + 1), Math.max(0, FUNDING_HOLD_MS - (Date.now() - nullSince.current)) + 5);
    return () => clearTimeout(t);
  }, [holding, key]);
  return holding ? good.current!.value : value;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const PRESETS = [25, 50, 75, 100];

export const ClosePositionForm: FC<ClosePositionFormProps> = ({
  positionSize,
  entryPrice,
  riskEntryPrice,
  busyOpenFeeAtoms = null,
  busyFeeMayApply = false,
  fundingPaidAtoms: fundingPaidAtomsRaw,
  holdingFeeExcluded,
  currentPrice: liveCurrentPrice,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  priceUsd: livePriceUsd,
  lotExp = 0,
  isLong,
  loading,
  tradingFeeBps = 0n,
  closeFeeBpsFor,
  spreadEstimateFor,
  oracleStale = false,
  oraclePriceBehind = false,
  priceAgeSecs = 0,
  settleMarkE6 = null,
  engineCatchingUp = false,
  catchUpMs = null,
  error = null,
  maxFillAbs = null,
  previewUnavailable = false,
  onConfirm,
  onCancel,
  variant = "modal",
  submitDisabled = false,
  submitDisabledLabel,
  submitTitle,
  onSubmitIntent,
}) => {
  // The form can render in the inline close panel and the modal, so no fixed id.
  const sliderId = useId();
  const [percent, setPercent] = useState(100);
  const updatePercent = (value: number) => setPercent(clampClosePercent(value));
  const isModal = variant === "modal";

  const colSym = collateralSymbol ?? symbol;
  const absPosition = abs(positionSize);
  const fundingPaidAtoms = useHeldFunding(fundingPaidAtomsRaw, `${isLong ? "L" : "S"}:${absPosition}:${entryPrice}`);

  const closeAbsForFills =
    percent >= 100 ? absPosition : (absPosition * BigInt(clampClosePercent(percent))) / 100n;
  const fillCount =
    !previewUnavailable && maxFillAbs != null && maxFillAbs > 0n && closeAbsForFills > 0n
      ? Number((closeAbsForFills + maxFillAbs - 1n) / maxFillAbs)
      : 1;

  // The chain settles a close at the STORED mark. While the live price is behind, the two can differ by
  // the whole move, so the preview follows the stored one.
  const useStored = oraclePriceBehind && settleMarkE6 != null && settleMarkE6 > 0n;
  const currentPrice = useStored ? settleMarkE6 : liveCurrentPrice;
  const priceUsd = useStored ? Number(settleMarkE6) / 1e6 : livePriceUsd;

  const preview = useMemo(() => {
    const closeAbs = percent >= 100 ? absPosition : (absPosition * BigInt(percent)) / 100n;
    const remainingAbs = absPosition - closeAbs;

    const closePositionSigned = isLong ? closeAbs : -closeAbs;
    const pnlNative =
      currentPrice > 0n && entryPrice > 0n
        ? computeMarkPnl(closePositionSigned, entryPrice, currentPrice)
        : 0n;
    const pnl = entryPrice > 0n ? computeMarkPnlLinear(closePositionSigned, entryPrice, currentPrice) : 0n;

    const closeNotional = currentPrice > 0n ? (closeAbs * currentPrice) / 1_000_000n : 0n;
    const spread = spreadEstimateFor ? spreadEstimateFor(closeAbs, !isLong, true) : null;
    // #3726: the whole close fee (base + the requested fee where the fee channel charges it), never below the base.
    const estBps = closeFeeBpsFor ? closeFeeBpsFor(closeAbs) : tradingFeeBps;
    let feeBps = estBps > tradingFeeBps ? estBps : tradingFeeBps;
    // F1: the chain charges base + the matcher's requested fee on a fee-channel market whether or not the ticket's P2 flag put it in the
    // estimate above (flag off = base only). When the channel is on and the estimate holds the base only, the displayed fee adds the quote's
    // requested bps (display only; what is signed is unchanged), so "included in the trading fee" is true and the preview is not high.
    // A close never carries the busy-side fee (growth_v19.rs), so an estimate above base on a close IS the charged quote.
    feeBps = feeBpsWithSpread(feeBps, spread, feeBps > tradingFeeBps);
    const feeEstimated = feeBps > tradingFeeBps;
    const closeFee = feeBps > 0n ? (closeNotional * feeBps) / 10_000n : 0n;

    // A close settles inside the trading account: nothing goes to the wallet, and the whole capital
    // stays (it still backs any remaining position). So the preview is the account balance after the
    // close: capital + the closed part's PnL − the fee, never capital × percent.
    // #3534: the closed part's PnL on the RISK entry: a loss a settle already moved out of `capital` is not charged again.
    const riskBasis = riskEntryPrice != null && riskEntryPrice > 0n ? riskEntryPrice : entryPrice;
    const balancePnl = riskBasis > 0n ? computeMarkPnlLinear(closePositionSigned, riskBasis, currentPrice) : 0n;
    const rawBalanceAfter = capital + balancePnl - closeFee;
    const balanceAfter = rawBalanceAfter > 0n ? rawBalanceAfter : 0n;

    const pnlUsd =
      priceUsd !== null && currentPrice > 0n
        ? (Number(pnlNative) / 10 ** decimals) * priceUsd
        : null;

    // r8 Council: Est. PnL is mark-to-market from the fill entry and gross of the closing fee + spread, so a trade that loses when closed
    // could read green. The headline is the NET result: that PnL less the same closing-fee estimate shown below (spread included).
    // While the spread-inclusive estimate is still loading (a quoter is wired but has not answered) there is no honest net: null.
    // A quoter that failed or is unavailable will never answer: show the net from the base-fee close estimate, labelled "excl. spread"
    // (never green: the spread could still turn it into a loss), instead of waiting forever.
    const spreadMissing = spreadEstimateFor != null && spread === null;
    const spreadUnavailable = spreadMissing && spreadEstimateFor?.unavailable === true;
    const feeLoading = spreadMissing && !spreadUnavailable;
    // r9 live verification: the realised trade result (the post-close "Trade result" and the chain) also carries the BASE fee paid when the
    // closed part was opened (the fill Entry holds the spread, not the base fee). Leaving it out let a trade that loses overall read green
    // when the mark sat just above the closing costs. Estimated on the booked (risk) entry the engine charged it on, for the closed part.
    const openFee = riskBasis > 0n && tradingFeeBps > 0n ? (((closeAbs * riskBasis) / 1_000_000n) * tradingFeeBps) / 10_000n : 0n;
    // r9 Risk MED: the busy-side fee paid at open (not in the Entry since #3810) is part of the realised result. Known: the closed part's share.
    // Unknown on a market that can charge one: the net stands but is "excl. busy-side fee" (never green).
    const busyKnown = busyOpenFeeAtoms !== null && busyOpenFeeAtoms >= 0n;
    const busyOpenFee = busyKnown ? busyFeeShareAtoms(busyOpenFeeAtoms, closeAbs, absPosition) : 0n;
    const netExclBusy = !busyKnown && busyFeeMayApply;
    // r10: the closed part's share of the funding the position has paid so far (signed, toward zero), never a guess when unknown.
    const fundingKnown = fundingPaidAtoms != null;
    const fundingShare = fundingKnown && absPosition > 0n ? (fundingPaidAtoms * closeAbs) / absPosition : 0n;
    const netExclFunding = fundingPaidAtoms === null;
    const netExclHolding = holdingFeeExcluded === true;
    const netResult = entryPrice > 0n && !feeLoading ? pnl - closeFee - openFee - busyOpenFee - fundingShare : null;

    return { closeAbs, remainingAbs, pnl, pnlUsd, closeFee, openFee, busyOpenFee, fundingShare, netExclFunding, netExclHolding, netExclBusy, netResult, feeLoading, netExclSpread: spreadUnavailable, feeEstimated, balanceAfter, spread };
  }, [percent, absPosition, isLong, entryPrice, riskEntryPrice, currentPrice, capital, priceUsd, tradingFeeBps, closeFeeBpsFor, spreadEstimateFor, decimals, busyOpenFeeAtoms, busyFeeMayApply, fundingPaidAtoms, holdingFeeExcluded]);

  // #2660: 0n = unknown entry (see the prop doc) — never a confident zero PnL.
  const entryKnown = entryPrice > 0n;
  const rawNet = preview.netResult;
  // A net inside half a cent of the collateral unit reads "0.00", neutral: never a red "-0.00" or a green "+0.00".
  // On a coin-margined market (the collateral is the asset itself) the band is half a cent of USD value: half a unit of a 9-decimal coin
  // is about $1. Otherwise (a stable collateral, or no price) it stays half a cent of the collateral unit.
  const collateralUsd = (collateralSymbol == null || collateralSymbol === symbol) && priceUsd !== null && priceUsd > 0 ? priceUsd : null;
  const netNearZero =
    rawNet !== null &&
    (collateralUsd !== null
      ? (Number(abs(rawNet)) / 10 ** decimals) * collateralUsd < 0.005
      : abs(rawNet) * 200n < 10n ** BigInt(decimals));
  const net = netNearZero ? 0n : rawNet;
  // Excluding the spread, a positive figure is not a safe "profit": it stays neutral (a loss is still red).
  const netColor =
    net === null || net === 0n || (net > 0n && (preview.netExclSpread || preview.netExclBusy || preview.netExclFunding || preview.netExclHolding))
      ? "text-[var(--text-muted)]"
      : net > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";
  // Est. result is valued from the FILL entry; Est. Account Balance After from the account's RISK entry (a settle may already have moved a
  // loss out of capital, #3534). When the two differ, say so, or the two rows look inconsistent.
  const entriesDiffer = entryPrice > 0n && riskEntryPrice != null && riskEntryPrice > 0n && riskEntryPrice !== entryPrice;

  const closeBlocked = loading || oracleStale || engineCatchingUp || submitDisabled;

  return (
    <>
      {isModal && (
        <div className="mb-4 flex items-center justify-between">
          <h2 id="close-position-title" className="text-sm font-bold uppercase tracking-[0.15em] text-[var(--text)]">
            Close Position
          </h2>
          <button
            onClick={onCancel}
            disabled={loading}
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Position info banner */}
      <div
        className={`mb-4 rounded-none border p-3 ${
          isLong ? "border-[var(--long)]/30 bg-[var(--long)]/5" : "border-[var(--short)]/30 bg-[var(--short)]/5"
        }`}
      >
        <p className="text-[10px] font-medium uppercase tracking-[0.15em]" style={{ color: isLong ? "var(--long)" : "var(--short)" }}>
          Closing {isLong ? "Long" : "Short"} Position
        </p>
        <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
          {previewUnavailable ? (
            <span style={{ fontFamily: "var(--font-mono)" }}>--</span>
          ) : (
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatLotQ(absPosition, decimals, lotExp)}</span>
          )}{" "}{symbol} at{" "}
          {entryKnown ? (
            <><span style={{ fontFamily: "var(--font-mono)" }}>{formatLotPriceE6(entryPrice, lotExp)}</span> entry</>
          ) : (
            <span title={UNKNOWN_ENTRY_TOOLTIP}>unknown entry</span>
          )}
        </p>
      </div>

      {/* Percentage slider */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor={sliderId} className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Close Amount</label>
          <span className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{percent}%</span>
        </div>
        <input
          id={sliderId}
          type="range"
          data-testid="close-percent-input"
          min={1}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => updatePercent(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, var(--short) 0%, var(--short) ${percent}%, rgba(255,255,255,0.03) ${percent}%, rgba(255,255,255,0.03) 100%)`,
            backgroundSize: "100% 2px",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            height: "20px",
          }}
          className="mb-2 h-1 w-full cursor-pointer appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-[var(--short)] [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--short)] [&::-moz-range-track]:bg-transparent"
        />
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => updatePercent(p)}
              data-testid="close-percent-chip"
              data-percent={p}
              className={`flex-1 rounded-none py-1 text-[10px] font-medium transition-colors duration-150 ${
                percent === p
                  ? "bg-[var(--short)] text-white"
                  : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:border-[var(--short)]/30 hover:text-[var(--text-secondary)]"
              }`}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>

      {/* Preview details */}
      {previewUnavailable ? (
        <p className="mb-6 text-[11px] leading-relaxed text-[var(--text-secondary)]" data-testid="close-preview-unavailable">
          The size and balance preview isn&apos;t available right now. Closing still uses your position&apos;s current size.
        </p>
      ) : (
      <>
      <div className="mb-6 space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-[var(--text-dim)]">Close Size:</span>
          <span className="font-mono font-medium text-[var(--text)]">
            {formatLotQ(preview.closeAbs, decimals, lotExp)} {symbol}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-dim)]">Remaining:</span>
          <span className="font-mono font-medium text-[var(--text)]">
            {formatLotQ(preview.remainingAbs, decimals, lotExp)} {symbol}
          </span>
        </div>
        <div className="flex justify-between border-t border-[var(--border)]/30 pt-2">
          <span className="font-medium text-[var(--text)]">Est. result if closed now:</span>
          {!entryKnown ? (
            <span className="font-mono font-medium text-[var(--text-muted)]" title={UNKNOWN_ENTRY_TOOLTIP} data-testid="close-net-unknown">
              --
            </span>
          ) : net === null ? (
            <span className="font-mono font-medium text-[var(--text-muted)]" title="Waiting for the closing fee and spread estimate" data-testid="close-net-loading">
              --
            </span>
          ) : (
            <span className={`font-mono font-medium ${netColor}`} data-testid="close-net-result" data-sign={net > 0n ? "positive" : net < 0n ? "negative" : "zero"}>
              {net > 0n ? "+" : net < 0n ? "-" : ""}
              {netNearZero ? "0.00" : formatTokenAmount(abs(net), decimals)} {colSym}
              {preview.netExclSpread && (
                <span className="ml-1 text-[10px] text-[var(--text-muted)]" title="The spread estimate could not be read, so this result excludes it" data-testid="close-net-excl-spread">
                  excl. spread
                </span>
              )}
              {preview.netExclFunding && (
                <span className="ml-1 text-[10px] text-[var(--text-muted)]" title="The funding this position has paid or received could not be worked out here, so this result excludes it" data-testid="close-net-excl-funding">
                  excl. funding
                </span>
              )}
              {preview.netExclHolding && (
                <span className="ml-1 text-[10px] text-[var(--text-muted)]" title="This market charges a holding fee, and it is not counted in this result" data-testid="close-net-excl-holding">
                  excl. holding fee
                </span>
              )}
              {preview.netExclBusy && (
                <span className="ml-1 text-[10px] text-[var(--text-muted)]" title="This position may have paid a busy-side fee when it was opened, and the amount is not recorded on this device, so this result excludes it" data-testid="close-net-excl-busy">
                  excl. busy-side fee
                </span>
              )}
            </span>
          )}
        </div>
        {entriesDiffer && (
          <p className="-mt-1 text-[9px] leading-relaxed text-[var(--text-dim)]" data-testid="close-net-basis">
            This result is measured from your fill price. The account balance below starts from what your account already settled, so the two can differ.
          </p>
        )}
        <div className="flex justify-between">
          <span className="text-[var(--text-dim)]">Est. PnL (before closing fees):</span>
          {!entryKnown ? (
            <span className="font-mono font-medium text-[var(--text-muted)]" title={UNKNOWN_ENTRY_TOOLTIP} data-testid="close-pnl-unknown">
              --
            </span>
          ) : (
          <span className="font-mono font-medium text-[var(--text-secondary)]" data-testid="close-gross-pnl">
            {preview.pnl > 0n ? "+" : preview.pnl < 0n ? "-" : ""}
            {formatTokenAmount(abs(preview.pnl), decimals)} {colSym}
            {preview.pnlUsd !== null && (
              <span className="ml-1 text-[10px]">
                ({preview.pnl > 0n ? "+" : preview.pnl < 0n ? "-" : ""}${Math.abs(preview.pnlUsd).toFixed(2)})
              </span>
            )}
          </span>
          )}
        </div>
        {preview.closeFee > 0n && (
          <div className="flex justify-between">
            <span className="text-[var(--text-dim)]">{preview.feeEstimated ? "Trading Fee (est.):" : "Trading Fee:"}</span>
            <span className="font-mono font-medium text-[var(--text-secondary)]">
              −{formatTokenAmount(preview.closeFee, decimals)} {colSym}
            </span>
          </div>
        )}
        {entryKnown && preview.openFee > 0n && (
          <div className="flex justify-between" data-testid="close-open-fee">
            <span className="text-[var(--text-dim)]">Opening fee (base, paid when you opened, est.):</span>
            <span className="font-mono font-medium text-[var(--text-secondary)]">
              −{formatTokenAmount(preview.openFee, decimals)} {colSym}
            </span>
          </div>
        )}
        {entryKnown && preview.busyOpenFee > 0n && (
          <div className="flex justify-between" data-testid="close-busy-open-fee">
            <span className="text-[var(--text-dim)]">Busy-side fee (paid when you opened):</span>
            <span className="font-mono font-medium text-[var(--text-secondary)]">
              −{formatTokenAmount(preview.busyOpenFee, decimals)} {colSym}
            </span>
          </div>
        )}
        {entryKnown && preview.fundingShare !== 0n && (
          <div className="flex justify-between" data-testid="close-funding">
            <span className="text-[var(--text-dim)]">{preview.fundingShare > 0n ? "Funding paid so far:" : "Funding received so far:"}</span>
            <span className="font-mono font-medium text-[var(--text-secondary)]">
              {preview.fundingShare > 0n ? "−" : "+"}{formatTokenAmount(abs(preview.fundingShare), decimals)} {colSym}
            </span>
          </div>
        )}
        <div className="flex justify-between gap-3" data-testid="close-spread">
          <span className="text-[var(--text-dim)]">{SPREAD_LABEL}:</span>
          <span className="text-right font-mono font-medium text-[var(--text-secondary)]">
            {spreadValueText(preview.spread)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-dim)]">Est. Account Balance After:</span>
          <span className="font-mono font-medium text-[var(--text)]" title={entryKnown ? undefined : "Excludes PnL — the entry price is unknown, so the PnL settled on close can't be previewed."}>
            ~{formatTokenAmount(preview.balanceAfter, decimals)} {colSym}
            {!entryKnown && <span className="ml-1 text-[10px] text-[var(--text-muted)]">excl. PnL</span>}
          </span>
        </div>
      </div>
      </>
      )}

      {/* A full close moves the freed balance back to the wallet in a second approval (useClosePosition,
          #2831, SWEEP_COPY); a partial close never sweeps, so the funds stay behind the rest of the
          position. Profit is not part of that sweep: it converts on withdraw once settled (tag 28, #2774). */}
      <p className="mb-4 -mt-2 text-[9px] text-[var(--text-dim)] leading-relaxed" data-testid="close-funds-stay">
        {percent >= 100
          ? "Your freed balance moves back to your wallet after one more approval."
          : "Closing keeps the funds in your trading account. Withdraw to move them to your wallet."}
      </p>
      {percent >= 100 && entryKnown && preview.pnl > 0n && (
        <p className="mb-4 -mt-3 text-[9px] text-[var(--text-dim)] leading-relaxed" data-testid="close-profit-settles">
          Profit becomes withdrawable once it settles.
        </p>
      )}

      {oracleStale ? (
        <div className="mb-4 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/[0.07] p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">⚠ Oracle Stale</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            The oracle price has not been updated recently. Closing is temporarily disabled to prevent failed transactions.
          </p>
        </div>
      ) : engineCatchingUp ? (
        <div data-testid="close-catching-up" className="mb-4 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/[0.07] p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">Catching up</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            {catchUpAvailableLine(catchUpMs, "close")}
          </p>
        </div>
      ) : oraclePriceBehind ? (
        <p data-testid="close-price-behind" className="mb-4 text-[9px] text-[var(--text-dim)] leading-relaxed">
          {priceBehindLine(priceAgeSecs)}
        </p>
      ) : null}

      {fillCount > 1 && (
        <div className="mb-4 rounded-none border border-[var(--border)] bg-[var(--bg)] p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">
            Closes as {fillCount} fills
          </p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            This close is larger than the market fills in one trade, so it executes as {fillCount} back-to-back
            fills inside a single transaction — one signature, no extra steps.
          </p>
        </div>
      )}

      {error && (
        <div data-testid="close-error" className="mb-4 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{error}</p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3">
        {isModal && (
          <button
            onClick={onCancel}
            data-testid="close-cancel"
            disabled={loading}
            className="flex-1 rounded-none border border-[var(--border)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => onConfirm(percent)}
          data-testid="close-confirm"
          onPointerEnter={onSubmitIntent}
          onFocus={onSubmitIntent}
          disabled={closeBlocked}
          title={submitTitle}
          className="flex-1 rounded-none bg-[var(--short)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-[filter,opacity] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Closing...
            </span>
          ) : submitDisabled && submitDisabledLabel ? (
            submitDisabledLabel
          ) : (
            `Close ${percent}%`
          )}
        </button>
      </div>
    </>
  );
};
