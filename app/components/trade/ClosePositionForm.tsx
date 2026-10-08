"use client";

import { priceBehindLine } from "@/lib/oracle-stale-gate";
import { FC, useId, useMemo, useState } from "react";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
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
  currentPrice: bigint;
  capital: bigint;
  /** Index asset symbol for position size (e.g. "SOL"). */
  symbol: string;
  /** Collateral symbol for PnL/receive (e.g. "USDC"). Falls back to symbol. */
  collateralSymbol?: string;
  decimals: number;
  priceUsd: number | null;
  isLong: boolean;
  loading: boolean;
  tradingFeeBps?: bigint;
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

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const PRESETS = [25, 50, 75, 100];

export const ClosePositionForm: FC<ClosePositionFormProps> = ({
  positionSize,
  entryPrice,
  currentPrice: liveCurrentPrice,
  capital,
  symbol,
  collateralSymbol,
  decimals,
  priceUsd: livePriceUsd,
  isLong,
  loading,
  tradingFeeBps = 0n,
  oracleStale = false,
  oraclePriceBehind = false,
  priceAgeSecs = 0,
  settleMarkE6 = null,
  engineCatchingUp = false,
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
    const closeFee = tradingFeeBps > 0n ? (closeNotional * tradingFeeBps) / 10_000n : 0n;

    // A close settles inside the trading account: nothing goes to the wallet, and the whole capital
    // stays (it still backs any remaining position). So the preview is the account balance after the
    // close: capital + the closed part's PnL − the fee, never capital × percent.
    const rawBalanceAfter = capital + pnl - closeFee;
    const balanceAfter = rawBalanceAfter > 0n ? rawBalanceAfter : 0n;

    const pnlUsd =
      priceUsd !== null && currentPrice > 0n
        ? (Number(pnlNative) / 10 ** decimals) * priceUsd
        : null;

    return { closeAbs, remainingAbs, pnl, pnlUsd, closeFee, balanceAfter };
  }, [percent, absPosition, isLong, entryPrice, currentPrice, capital, priceUsd, tradingFeeBps, decimals]);

  // #2660: 0n = unknown entry (see the prop doc) — never a confident zero PnL.
  const entryKnown = entryPrice > 0n;
  const pnlColor =
    preview.pnl === 0n
      ? "text-[var(--text-muted)]"
      : preview.pnl > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

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
            className="text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
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
            <span style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(absPosition, decimals)}</span>
          )}{" "}{symbol} at{" "}
          {entryKnown ? (
            <><span style={{ fontFamily: "var(--font-mono)" }}>{formatUsdPriceE6(entryPrice)}</span> entry</>
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
            {formatTokenAmount(preview.closeAbs, decimals)} {symbol}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--text-dim)]">Remaining:</span>
          <span className="font-mono font-medium text-[var(--text)]">
            {formatTokenAmount(preview.remainingAbs, decimals)} {symbol}
          </span>
        </div>
        <div className="flex justify-between border-t border-[var(--border)]/30 pt-2">
          <span className="text-[var(--text-dim)]">Est. PnL:</span>
          {!entryKnown ? (
            <span className="font-mono font-medium text-[var(--text-muted)]" title={UNKNOWN_ENTRY_TOOLTIP} data-testid="close-pnl-unknown">
              --
            </span>
          ) : (
          <span className={`font-mono font-medium ${pnlColor}`}>
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
            <span className="text-[var(--text-dim)]">Trading Fee:</span>
            <span className="font-mono font-medium text-[var(--text-secondary)]">
              −{formatTokenAmount(preview.closeFee, decimals)} {colSym}
            </span>
          </div>
        )}
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
            Prices are catching up. Closing resumes once the market has caught up.
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
