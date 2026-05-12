"use client";

/**
 * StepReviewDemo — clone of StepReview with all balance / wallet / mint
 * gates stripped so the wizard's Step 4 always renders "Mint verified"
 * and "LAUNCH MARKET →" regardless of the connected wallet's state.
 *
 * Used only when CreateMarketWizard is mounted with isMockMode() === true
 * (typically via /create?mock=1 or /demo-shots/create). Production builds
 * never reach this file.
 *
 * Sync notes: when StepReview.tsx changes its visual layout, this file
 * should be updated to match. Functional gates intentionally diverge.
 */

import { FC } from "react";
import { type SlabTierKey, SLAB_TIERS } from "@percolatorct/sdk";
import { CostEstimate } from "../create/CostEstimate";

interface StepReviewDemoProps {
  tokenSymbol: string;
  tokenName: string;
  mintAddress: string;
  tokenDecimals: number;
  priceUsd?: number;
  oracleType: "pyth" | "hyperp_ema" | "admin";
  oracleLabel: string;
  slabTier: SlabTierKey;
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  onBack: () => void;
  onLaunch: () => void;
}

const TX_STEPS = [
  { label: "Create slab & initialize market", detail: "Atomic — rolls back if any part fails" },
  { label: "Oracle setup & crank", detail: "Configure price feed, first crank" },
  { label: "Initialize LP", detail: "Create liquidity provider pool" },
  { label: "Deposit, insurance & finalize", detail: "Seed capital + insurance fund" },
  { label: "Insurance LP mint", detail: "Enable permissionless insurance deposits" },
] as const;

export const StepReviewDemo: FC<StepReviewDemoProps> = ({
  tokenSymbol,
  mintAddress,
  tokenDecimals,
  priceUsd,
  oracleType,
  oracleLabel,
  slabTier,
  tradingFeeBps,
  initialMarginBps,
  lpCollateral,
  insuranceAmount,
  onBack,
  onLaunch,
}) => {
  const maxLeverage = Math.floor(10000 / initialMarginBps);
  const tier = SLAB_TIERS[slabTier];

  const oracleTypeLabel =
    oracleType === "pyth"
      ? "Pyth"
      : oracleType === "hyperp_ema"
        ? "HyperpEMA"
        : "Admin";

  return (
    <div className="space-y-5">
      {/* Mint verified — always green in demo mode */}
      <div className="p-3 bg-green-500/20 border border-green-500 rounded text-green-500 text-sm">
        ✅ Mint verified on mainnet
      </div>

      {/* Market Preview Card */}
      <div>
        <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
          Market Preview
        </p>
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.02] backdrop-blur">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--accent)]/10">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[12px] font-bold text-[var(--accent)]">
                {tokenSymbol.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <h3
                  className="text-[14px] font-bold text-[var(--text)]"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {tokenSymbol}-PERP
                </h3>
                <p className="text-[10px] text-[var(--text-secondary)]">
                  Oracle: {oracleTypeLabel} · {oracleLabel}
                </p>
                <p className="text-[9px] text-[var(--text-secondary)] font-mono mt-0.5">
                  Mint: {mintAddress.slice(0, 8)}...{mintAddress.slice(-6)}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1.5 justify-end">
                <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">
                  {tradingFeeBps} bps
                </span>
                <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">
                  {maxLeverage}x
                </span>
                <span className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.06] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--accent)]">
                  {tier.label}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Cost Breakdown */}
      <CostEstimate
        slabTier={slabTier}
        lpCollateral={lpCollateral}
        insuranceAmount={insuranceAmount}
        tokenSymbol={tokenSymbol}
        tokenDecimals={tokenDecimals}
        tokenPriceUsd={priceUsd}
      />

      {/* Demo balance line — always green */}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-[var(--long)]">✓</span>
        <span className="text-[var(--text-secondary)]">
          Wallet ready · demo mode (no real funds required)
        </span>
      </div>

      {/* Transaction Steps */}
      <div>
        <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
          Transaction Steps
        </p>
        <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3 space-y-2">
          {TX_STEPS.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]">
              <span className="text-[10px] font-mono text-[var(--text-secondary)] mt-0.5 flex-shrink-0">{i + 1}.</span>
              <div className="min-w-0">
                <span className="text-[var(--text)]">{step.label}</span>
                <span className="hidden sm:inline text-[10px] text-[var(--text-secondary)] ml-2">
                  — {step.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
          {TX_STEPS.length} transactions — each requires a wallet signature.
          {" "}Step 1 is atomic: if it fails, no SOL is lost.
        </p>
      </div>

      {/* Navigation — launch button always enabled, always cyan, no error states */}
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
          onClick={onLaunch}
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3.5 text-[14px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
        >
          LAUNCH MARKET →
        </button>
      </div>
    </div>
  );
};
