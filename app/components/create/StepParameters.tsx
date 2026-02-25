"use client";

import { FC } from "react";
import { type SlabTierKey } from "@percolator/sdk";
import { SlabTierPicker } from "./SlabTierPicker";
import { FeeSlider } from "./FeeSlider";
import { ConflictWarning } from "./ConflictWarning";

interface StepParametersProps {
  mode: "quick" | "manual";
  slabTier: SlabTierKey;
  onSlabTierChange: (tier: SlabTierKey) => void;
  tradingFeeBps: number;
  onTradingFeeChange: (bps: number) => void;
  initialMarginBps: number;
  onInitialMarginChange: (bps: number) => void;
  lpCollateral: string;
  onLpCollateralChange: (val: string) => void;
  insuranceAmount: string;
  onInsuranceAmountChange: (val: string) => void;
  adminPrice: string | null;
  onAdminPriceChange: (val: string) => void;
  isAdminOracle: boolean;
  tokenSymbol: string;
  walletBalance: string | null;
  onContinue: () => void;
  onBack: () => void;
  canContinue: boolean;
}

/**
 * Step 3 — Market Parameters: slab tier, trading fee, leverage, seed deposits.
 */
export const StepParameters: FC<StepParametersProps> = ({
  mode,
  slabTier,
  onSlabTierChange,
  tradingFeeBps,
  onTradingFeeChange,
  initialMarginBps,
  onInitialMarginChange,
  lpCollateral,
  onLpCollateralChange,
  insuranceAmount,
  onInsuranceAmountChange,
  adminPrice,
  onAdminPriceChange,
  isAdminOracle,
  tokenSymbol,
  walletBalance,
  onContinue,
  onBack,
  canContinue,
}) => {
  const maxLeverage = Math.floor(10000 / initialMarginBps);
  const feeConflict = tradingFeeBps >= initialMarginBps;

  return (
    <div className="space-y-6">
      {/* Slab Tier */}
      <div>
        <label className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-3">
          Slab Tier
        </label>
        <SlabTierPicker value={slabTier} onChange={onSlabTierChange} />
      </div>

      {/* Trading Fee */}
      <FeeSlider
        label="Trading Fee"
        value={tradingFeeBps}
        onChange={onTradingFeeChange}
        min={1}
        max={1000}
        showPercent
      />

      {/* Leverage (derived, read-only) */}
      <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">
            Max Leverage
          </span>
          <span className="text-[14px] font-bold text-white">
            {maxLeverage}x
          </span>
        </div>
        <p className="text-[10px] text-[var(--text-dim)] mt-1">
          Auto from margin: {initialMarginBps} bps ({(initialMarginBps / 100).toFixed(0)}%)
        </p>
      </div>

      {/* Initial Margin (editable in manual mode, derived display in quick) */}
      {mode === "manual" && (
        <FeeSlider
          label="Initial Margin"
          value={initialMarginBps}
          onChange={onInitialMarginChange}
          min={100}
          max={5000}
          showPercent={false}
        />
      )}

      {/* Conflict Warning */}
      <ConflictWarning
        tradingFeeBps={tradingFeeBps}
        initialMarginBps={initialMarginBps}
      />

      {/* Admin price input (if no oracle) */}
      {isAdminOracle && (
        <div>
          <label
            htmlFor="admin-price"
            className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2"
          >
            Initial Price (admin oracle)
          </label>
          <input
            id="admin-price"
            type="text"
            value={adminPrice ?? "1.000000"}
            onChange={(e) => onAdminPriceChange(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="1.000000"
            className="w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-[12px] font-mono text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40 focus:outline-none"
          />
          <p className="mt-1 text-[10px] text-[var(--text-dim)]">
            This sets the starting mark price. Update via your crank.
          </p>
        </div>
      )}

      {/* Seed Deposit (LP Collateral) */}
      <div>
        <label
          htmlFor="lp-collateral"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2"
        >
          Seed Deposit (LP collateral){" "}
          {tokenSymbol && (
            <span className="normal-case tracking-normal text-[var(--text-dim)]">
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
          <p className="mt-1 text-[10px] font-mono text-[var(--text-dim)]">
            Wallet balance: {walletBalance} {tokenSymbol}
          </p>
        )}
      </div>

      {/* Insurance Fund Seed */}
      <div>
        <label
          htmlFor="insurance-amount"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] mb-2"
        >
          Insurance Fund Seed{" "}
          {tokenSymbol && (
            <span className="normal-case tracking-normal text-[var(--text-dim)]">
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
        <p className="mt-1 text-[10px] text-[var(--text-dim)]">
          Minimum: 100 tokens
        </p>
      </div>

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
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
        >
          CONTINUE →
        </button>
      </div>
    </div>
  );
};
