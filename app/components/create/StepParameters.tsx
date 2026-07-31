"use client";

import { FC } from "react";
import { LeveragePicker } from "./LeveragePicker";
import { ConflictWarning } from "./ConflictWarning";
import { FeeSplitControl, type FeeSplitBps } from "./FeeSplitControl";
import { getNetwork } from "@/lib/config";

interface StepParametersProps {
  tradingFeeBps: number;
  feeSplit: FeeSplitBps;
  onFeeSplitChange: (next: FeeSplitBps) => void;
  initialMarginBps: number;
  onInitialMarginChange: (bps: number) => void;
  lpCollateral: string;
  onLpCollateralChange: (val: string) => void;
  insuranceAmount: string;
  onInsuranceAmountChange: (val: string) => void;
  /** Resolved opening price (USD, as a decimal string), or null if the oracle
   *  lookup has not produced one. Display-only — see the render block below. */
  adminPrice: string | null;
  isAdminOracle: boolean;
  tokenSymbol: string;
  walletBalance: string | null;
  onContinue: () => void;
  onBack: () => void;
  canContinue: boolean;
  /**
   * Why Continue is disabled, when the reason is a property of the TOKEN rather
   * than of a field on this form (e.g. no supported DEX pool, so the keeper
   * could never price the market). Every other blocker here is visible at the
   * field that causes it; this one has no field, so without it the user just
   * gets a dead button and no way to work out why. Null when not blocked.
   */
  blockedReason?: string | null;
}

/**
 * Step 2 — Market Parameters: fee split, leverage, seed deposits.
 *
 * Slab tier was removed with the mode selector (vestigial under v17). Trading
 * fee is displayed but deliberately has NO setter — it is fixed for every
 * market so a creator cannot undercut the fees that keep the market solvent.
 */
export const StepParameters: FC<StepParametersProps> = ({
  tradingFeeBps,
  feeSplit,
  onFeeSplitChange,
  initialMarginBps,
  onInitialMarginChange,
  lpCollateral,
  onLpCollateralChange,
  insuranceAmount,
  onInsuranceAmountChange,
  adminPrice,
  isAdminOracle,
  tokenSymbol,
  walletBalance,
  onContinue,
  onBack,
  canContinue,
  blockedReason = null,
}) => {
  const feeConflict = tradingFeeBps >= initialMarginBps;
  const isMainnet = getNetwork() === "mainnet";

  return (
    <div className="space-y-6">
      {/* Trading Fee — FIXED, not creator-settable.
          One rate for every market: a creator undercutting on fees does not
          make their market better, it just starves the LP and insurance shares
          that keep it solvent. The creator's cut is set in the fee SPLIT below,
          which is the knob that actually belongs to them. */}
      <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)]">
            Trading Fee
          </span>
          <span className="text-[14px] font-bold tabular-nums text-[var(--text)]">
            {tradingFeeBps} bps
          </span>
        </div>
        <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
          Same on every market. Your share of it is set in the fee split below.
        </p>
      </div>

      {/* Fee Split — creator/LP/insurance shares of the trade fee. Previously
          manual-mode only; now a core parameter, since the mode selector is
          gone. The wrapper enforces the sum + floors; this control validates
          client-side so a bad split can't reach chain. */}
      <FeeSplitControl value={feeSplit} onChange={onFeeSplitChange} />

      {/* Leverage — the creator's choice, and the ONLY risk parameter they set.
          Everything downstream (maintenance margin, price-move budget, LP fill
          and inventory caps) is derived from it in lib/market-params.ts, so a
          creator cannot pick an incoherent combination. */}
      <LeveragePicker
        initialMarginBps={initialMarginBps}
        onChange={onInitialMarginChange}
      />

      {/* Mainnet Phase 1 Guards */}
      {isMainnet && (
        <div className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] px-4 py-3 text-[11px] space-y-1">
          <p className="text-[var(--accent)] font-medium">⚡ Mainnet Phase 1 Guards Active</p>
          <p className="text-[var(--text)]">• $10K OI cap per market during beta</p>
          <p className="text-[var(--text)]">• 2x max leverage enforced on-chain</p>
          <p className="text-[var(--text)]">• Guards auto-lift when caps are raised by DAO</p>
        </div>
      )}

      {/* Conflict Warning */}
      <ConflictWarning
        tradingFeeBps={tradingFeeBps}
        initialMarginBps={initialMarginBps}
      />

      {/* Opening price — DERIVED, not creator-settable.
          This price does far more than set the starting mark: deriveMarketParams()
          converts the LP's notional guardrails (maxInventoryAbs / maxFillAbs) into a
          TOKEN count using it, and those caps are written once at creation and can
          never be changed (the matcher has no update instruction). A typed price that
          disagrees with the oracle's therefore mis-sizes the per-trade cap by exactly
          that ratio, permanently. That is not hypothetical: market 5sDvEs2… launched
          at a hand-entered 0.001359 while its feed published 0.000011, and its $1,000
          per-trade cap became $9.57 — every larger trade failed with a bare
          InvalidAccountData. So the opening price now comes from the same oracle
          resolution the market will actually run on, and is shown read-only. */}
      {isAdminOracle && (
        <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)]">
              Opening Price
            </span>
            {adminPrice ? (
              <span className="text-[14px] font-bold tabular-nums text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                ${adminPrice}
              </span>
            ) : (
              <span className="text-[12px] font-semibold text-[var(--danger,#ef4444)]">
                unavailable
              </span>
            )}
          </div>
          <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
            {adminPrice
              ? "Detected from this token's live market. Sets the opening mark and sizes the LP's trade caps, so it is not editable."
              : "No live price could be resolved for this token. A market cannot be launched until one is — launching at a wrong price permanently mis-sizes the LP's trade caps."}
          </p>
        </div>
      )}

      {/* Seed Deposit (LP Collateral) */}
      <div>
        <label
          htmlFor="lp-collateral"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)] mb-2"
        >
          Seed Deposit (LP collateral){" "}
          {tokenSymbol && (
            <span className="normal-case tracking-normal text-[var(--text-secondary)]">
              in {tokenSymbol}
            </span>
          )}
        </label>
        <input
          id="lp-collateral"
          type="text"
          value={lpCollateral}
          onChange={(e) => onLpCollateralChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="Amount..."
          className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[12px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none"
        />
        {walletBalance && (
          <p className="mt-1 text-[10px] font-mono text-[var(--text-secondary)]">
            Wallet balance: {walletBalance} {tokenSymbol}
          </p>
        )}
      </div>

      {/* Insurance Fund Seed */}
      <div>
        <label
          htmlFor="insurance-amount"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)] mb-2"
        >
          Insurance Fund Seed{" "}
          {tokenSymbol && (
            <span className="normal-case tracking-normal text-[var(--text-secondary)]">
              in {tokenSymbol}
            </span>
          )}
        </label>
        <input
          id="insurance-amount"
          type="text"
          value={insuranceAmount}
          onChange={(e) => onInsuranceAmountChange(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100"
          className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[12px] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none"
        />
        <p className="mt-1 text-[10px] text-[var(--text-secondary)]">
          Minimum: 100 tokens
        </p>
      </div>

      {/* Why Continue is dead, when the cause is the token and not a field. */}
      {blockedReason && (
        <div
          role="alert"
          className="border border-[var(--short)]/40 bg-[var(--short)]/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-secondary)]"
        >
          <span className="font-medium uppercase tracking-[0.1em] text-[var(--short)]">
            Cannot launch
          </span>
          <p className="mt-1">{blockedReason}</p>
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="border border-[var(--border)] bg-transparent px-5 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
        >
          ← BACK
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue || feeConflict}
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-secondary)]"
        >
          CONTINUE →
        </button>
      </div>
    </div>
  );
};
