"use client";

import { FC } from "react";
import {
  deriveMarketParams,
  MIN_LEVERAGE_X,
  MAX_LEVERAGE_X,
} from "@/lib/market-params";

interface LeveragePickerProps {
  /** Current on-chain initial margin, in bps. */
  initialMarginBps: number;
  /** Emits the new initial margin in bps — the wizard's unit. */
  onChange: (bps: number) => void;
}

/** Whole-number steps a creator would actually reach for. */
const CHOICES = [2, 3, 4, 5, 8, 10] as const;

function marginBpsFor(lev: number): number {
  return deriveMarketParams(lev, 0n, 1_000_000n).initialMarginBps;
}

/**
 * Leverage picker for Step 3.
 *
 * Replaces a raw "Initial Margin (bps)" slider. Two reasons that slider was the
 * wrong control:
 *
 *  1. It let a creator pick anything from 100 to 5000 bps (100x to 2x), but the
 *     engine only ever gets 10x..2x — the derivation clamps. A request for 100x
 *     was silently turned into a 10x market with no warning.
 *  2. Creators think in leverage, not margin bps. The slider asked for the
 *     inverse of the number they care about, then displayed a "Max Leverage"
 *     computed by raw division, which disagreed with what was actually written
 *     on-chain.
 *
 * Everything shown here comes from deriveMarketParams — the same call the launch
 * path uses — so the preview cannot drift from what gets created. This matters
 * more than usual: leverage is written ONCE at market creation and there is no
 * instruction to change it afterwards.
 */
export const LeveragePicker: FC<LeveragePickerProps> = ({
  initialMarginBps,
  onChange,
}) => {
  // Match on margin, not on a stored leverage, so the selection always reflects
  // what will actually be written on-chain.
  const selectedLev =
    CHOICES.find((l) => marginBpsFor(l) === initialMarginBps) ?? null;
  const active = selectedLev ?? MAX_LEVERAGE_X;
  const derived = deriveMarketParams(active, 0n, 1_000_000n);

  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)] mb-3">
        Max Leverage
      </label>

      <div
        role="radiogroup"
        aria-label="Max leverage"
        className="grid grid-cols-3 gap-2 sm:grid-cols-6"
      >
        {CHOICES.map((lev) => {
          const selected = marginBpsFor(lev) === initialMarginBps;
          return (
            <button
              key={lev}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(marginBpsFor(lev))}
              className={`border px-2 py-3 text-center transition-all ${
                selected
                  ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
                  : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]/20"
              }`}
            >
              <span
                className={`block text-[15px] font-bold tabular-nums ${
                  selected ? "text-[var(--accent)]" : "text-[var(--text)]"
                }`}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {lev}x
              </span>
              <span className="mt-0.5 block text-[10px] text-[var(--text-secondary)]">
                {(marginBpsFor(lev) / 100).toFixed(0)}% margin
              </span>
            </button>
          );
        })}
      </div>

      {/* The trade-off, stated plainly. Higher leverage means thinner
          maintenance margin, which the engine compensates for by allowing a
          SMALLER per-slot price-move budget — so a fast market takes longer to
          reopen after a large move. Creators should see that before choosing,
          because it cannot be changed later. */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-[11px] sm:grid-cols-4">
        <div>
          <dt className="text-[var(--text-secondary)]">Initial margin</dt>
          <dd className="tabular-nums text-[var(--text)]">{derived.initialMarginBps} bps</dd>
        </div>
        <div>
          <dt className="text-[var(--text-secondary)]">Maintenance</dt>
          <dd className="tabular-nums text-[var(--text)]">{derived.maintenanceMarginBps} bps</dd>
        </div>
        <div>
          <dt className="text-[var(--text-secondary)]">Price-move budget</dt>
          <dd className="tabular-nums text-[var(--text)]">
            {derived.maxPriceMoveBpsPerSlot} bps/slot
          </dd>
        </div>
        <div>
          <dt className="text-[var(--text-secondary)]">Recovery after 26% move</dt>
          <dd className="tabular-nums text-[var(--text)]">
            ~{derived.estimatedFreezeSecondsFor26PctMove}s
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
        Written once at creation and permanent — there is no instruction to change a
        market&apos;s leverage afterwards. Higher leverage buys traders more size but
        leaves less room to absorb a fast move. Range is {MIN_LEVERAGE_X}x–{MAX_LEVERAGE_X}x.
      </p>
    </div>
  );
};
