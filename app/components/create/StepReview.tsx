"use client";

import { FC, useMemo } from "react";
import { type SlabTierKey, SLAB_TIERS } from "@percolator/sdk";
import { CostEstimate } from "./CostEstimate";

interface StepReviewProps {
  // Token
  tokenSymbol: string;
  tokenName: string;
  mintAddress: string;
  tokenDecimals: number;
  priceUsd?: number;
  // Oracle
  oracleType: "pyth" | "hyperp_ema" | "admin";
  oracleLabel: string;
  // Parameters
  slabTier: SlabTierKey;
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  // Wallet
  walletConnected: boolean;
  walletBalanceSol: number | null;
  hasSufficientBalance: boolean;
  requiredSol?: number;
  hasTokens: boolean;
  hasSufficientTokensForSeed: boolean;
  feeConflict: boolean;
  // Actions
  onBack: () => void;
  onLaunch: () => void;
  canLaunch: boolean;
}

const TX_STEPS = [
  { label: "Create slab & initialize market", detail: "Atomic — rolls back if any part fails" },
  { label: "Oracle setup & crank", detail: "Configure price feed, first crank" },
  { label: "Initialize LP", detail: "Create liquidity provider pool" },
  { label: "Deposit, insurance & finalize", detail: "Seed capital + insurance fund" },
  { label: "Insurance LP mint", detail: "Enable permissionless insurance deposits" },
] as const;

/**
 * Step 4 — Review & Confirm.
 * Market preview, cost breakdown, transaction steps, and launch button.
 */
export const StepReview: FC<StepReviewProps> = ({
  tokenSymbol,
  tokenName,
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
  walletConnected,
  walletBalanceSol,
  hasSufficientBalance,
  requiredSol,
  hasTokens,
  hasSufficientTokensForSeed,
  feeConflict,
  onBack,
  onLaunch,
  canLaunch,
}) => {
  const maxLeverage = Math.floor(10000 / initialMarginBps);
  const tier = SLAB_TIERS[slabTier];

  const oracleTypeLabel =
    oracleType === "pyth"
      ? "Pyth"
      : oracleType === "hyperp_ema"
        ? "HyperpEMA"
        : "Admin";

  const launchButtonLabel = useMemo(() => {
    if (!walletConnected) return "Connect Wallet to Launch";
    if (!hasTokens) return "No Tokens — Mint First";
    if (!hasSufficientTokensForSeed) return "Insufficient Tokens for Vault Seed (500)";
    if (feeConflict) return "Fix Parameters to Continue";
    if (!hasSufficientBalance) return "Insufficient SOL";
    return "LAUNCH MARKET";
  }, [walletConnected, hasTokens, hasSufficientTokensForSeed, feeConflict, hasSufficientBalance]);

  return (
    <div className="space-y-5">
      {/* Market Preview Card */}
      <div>
        <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
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
                  className="text-[14px] font-bold text-white"
                  style={{ fontFamily: "var(--font-heading)" }}
                >
                  {tokenSymbol}-PERP
                </h3>
                <p className="text-[10px] text-[var(--text-dim)]">
                  Oracle: {oracleTypeLabel} · {oracleLabel}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1.5 justify-end">
                <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-muted)]">
                  {tradingFeeBps} bps
                </span>
                <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--text-muted)]">
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

      {/* Balance check */}
      {walletConnected && walletBalanceSol !== null && (
        <div className="flex items-center gap-2 text-[11px]">
          {hasSufficientBalance ? (
            <>
              <span className="text-[var(--long)]">✓</span>
              <span className="text-[var(--text-muted)]">
                Your balance: {walletBalanceSol.toFixed(4)} SOL
              </span>
            </>
          ) : (
            <>
              <span className="text-[var(--short)]">✗</span>
              <span className="text-[var(--short)]">
                Insufficient SOL — balance: {walletBalanceSol.toFixed(4)} SOL{requiredSol ? `, need ~${requiredSol.toFixed(4)} SOL` : ""}
              </span>
            </>
          )}
        </div>
      )}

      {/* Transaction Steps */}
      <div>
        <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Transaction Steps
        </p>
        <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3 space-y-2">
          {TX_STEPS.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]">
              <span className="text-[10px] font-mono text-[var(--text-dim)] mt-0.5 flex-shrink-0">{i + 1}.</span>
              <div className="min-w-0">
                <span className="text-[var(--text-dim)]">{step.label}</span>
                <span className="hidden sm:inline text-[10px] text-[var(--text-dim)]/60 ml-2">
                  — {step.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-[var(--text-dim)]">
          {TX_STEPS.length} transactions — each requires a wallet signature.
          {" "}Step 1 is atomic: if it fails, no SOL is lost.
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
          onClick={onLaunch}
          disabled={!canLaunch}
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3.5 text-[14px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
        >
          {launchButtonLabel}
        </button>
      </div>
    </div>
  );
};
