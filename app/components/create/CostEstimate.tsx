"use client";

import { FC, useMemo } from "react";
import { type SlabTierKey, SLAB_TIERS } from "@/lib/slabTiers";
import { DEFAULT_SLAB_SIZE } from "@/hooks/useCreateMarket";

interface CostEstimateProps {
  slabTier: SlabTierKey;
  lpCollateral: string;
  insuranceAmount: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenPriceUsd?: number;
  className?: string;
}

/** Lamports per byte for rent exemption (approximation: 6960 lamports/byte + 128 bytes overhead) */
const RENT_PER_BYTE = 6960;
const RENT_OVERHEAD_BYTES = 128;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Estimated transaction fees for the ~9-10 signed-transaction creation flow (see
 *  useCreateMarket's create() / StepReview's BASE_TX_STEPS for the exact sequence —
 *  bumped from 8 when the Earn vault + stake pool steps were added). */
const TX_FEE_ESTIMATE_SOL = 0.031; // ~10 transactions × 5000 lamports each + priority fee headroom

/**
 * Additional rent for the Earn LP vault + stake pool accounts created by Steps 4/5
 * (see useCreateMarket.ts's create()):
 *   - LP Vault Registry PDA: 176 bytes (paid by the creator inside CreateLpVault)
 *   - LP Vault (Earn) mint PDA: 82 bytes (paid by the creator inside CreateLpVault)
 *   - Stake pool LP mint: 82 bytes (explicit client-paid CreateAccount)
 *   - Stake pool collateral vault token account: 165 bytes (explicit client-paid CreateAccount)
 *   - Stake pool PDA itself: 352 bytes (paid by the creator via CPI inside StakeInitPool)
 */
const EARN_VAULT_AND_STAKE_RENT_BYTES = 176 + 82 + 82 + 165 + 352;

/**
 * Detailed cost breakdown for market creation.
 * Shows rent costs, token requirements, and transaction fees.
 */
export const CostEstimate: FC<CostEstimateProps> = ({
  slabTier,
  lpCollateral,
  insuranceAmount,
  tokenSymbol,
  tokenDecimals,
  tokenPriceUsd,
  className = "",
}) => {
  const estimate = useMemo(() => {
    const tier = SLAB_TIERS[slabTier];
    // BUG 1 fix: the v17 slab account length is FIXED at v17MarketAccountLen(14)
    // (DEFAULT_SLAB_SIZE) regardless of tier — InitMarket always encodes
    // maxPortfolioAssets:14, so it always sizes/rents the slab the same way no matter
    // which tier the user picks. Tier only selects which deployed program (trader-
    // account capacity) InitMarket targets — it no longer scales the slab's byte size.
    // Using the stale v12.19 tier.dataSize here grossly over-estimated rent (by ~0.67
    // SOL) for a cost that was never actually charged this way.
    const dataSize = DEFAULT_SLAB_SIZE;

    // Rent-exempt minimum for the slab account
    const slabRentLamports = Math.ceil((dataSize + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE);
    const slabRentSol = slabRentLamports / LAMPORTS_PER_SOL;

    // Additional rent for token accounts (vault ATA, LP mint, insurance LP mint)
    // Each token account ~165 bytes, each mint ~82 bytes
    const tokenAccountRentSol = (165 * 3 + 82 * 2) * RENT_PER_BYTE / LAMPORTS_PER_SOL;

    // Rent for the Earn vault (Step 4) + stake pool (Step 5) accounts — see
    // EARN_VAULT_AND_STAKE_RENT_BYTES doc comment above.
    const earnVaultStakeRentSol = (EARN_VAULT_AND_STAKE_RENT_BYTES * RENT_PER_BYTE) / LAMPORTS_PER_SOL;

    // Total SOL cost
    const totalSolCost = slabRentSol + tokenAccountRentSol + earnVaultStakeRentSol + TX_FEE_ESTIMATE_SOL;

    // Token costs (vault seed is 500_000_000 raw = 500 at 6 decimals)
    const seedAmount = 500_000_000 / Math.pow(10, tokenDecimals);
    const lpNum = parseFloat(lpCollateral) || 0;
    const insNum = parseFloat(insuranceAmount) || 0;
    const totalTokens = seedAmount + lpNum + insNum;

    // USD values if price available
    const tokenUsdValue = tokenPriceUsd ? totalTokens * tokenPriceUsd : null;

    return {
      slabRentSol: slabRentSol.toFixed(4),
      tokenAccountRentSol: tokenAccountRentSol.toFixed(4),
      earnVaultStakeRentSol: earnVaultStakeRentSol.toFixed(4),
      txFeeSol: TX_FEE_ESTIMATE_SOL.toFixed(4),
      totalSolCost: totalSolCost.toFixed(4),
      seedTokens: seedAmount,
      lpTokens: lpNum,
      insTokens: insNum,
      totalTokens,
      tokenUsdValue,
      tierLabel: tier.label,
      tierSlots: tier.maxAccounts,
      dataSize,
    };
  }, [slabTier, lpCollateral, insuranceAmount, tokenPriceUsd]);

  return (
    <div className={`border border-[var(--border)] bg-[var(--bg)] ${className}`}>
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--text)]">
          Cost Estimate
        </h4>
      </div>

      {/* SOL Costs */}
      <div className="px-4 py-3 space-y-2 border-b border-[var(--border)]">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">
            Slab account rent ({estimate.tierLabel}, {estimate.tierSlots} slots)
          </span>
          <span className="font-mono text-[var(--text)]">{estimate.slabRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Token accounts & mints</span>
          <span className="font-mono text-[var(--text)]">{estimate.tokenAccountRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Earn vault & stake pool</span>
          <span className="font-mono text-[var(--text)]">{estimate.earnVaultStakeRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Transaction fees (~9 txs)</span>
          <span className="font-mono text-[var(--text)]">{estimate.txFeeSol} SOL</span>
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <span className="text-[11px] font-semibold text-[var(--text)]">Total SOL Required</span>
          <span className="text-[13px] font-bold font-mono text-[var(--accent)]">
            ~{estimate.totalSolCost} SOL
          </span>
        </div>
      </div>

      {/* Token Costs */}
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Vault Seed (required)</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.seedTokens.toLocaleString()} {tokenSymbol}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">LP Collateral</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.lpTokens > 0 ? estimate.lpTokens.toLocaleString() : "—"} {tokenSymbol}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Insurance Fund</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.insTokens > 0 ? estimate.insTokens.toLocaleString() : "—"} {tokenSymbol}
          </span>
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <span className="text-[11px] font-semibold text-[var(--text)]">Total Tokens Required</span>
          <div className="text-right">
            <span className="text-[13px] font-bold font-mono text-[var(--text)]">
              {estimate.totalTokens > 0 ? estimate.totalTokens.toLocaleString() : "—"} {tokenSymbol}
            </span>
            {estimate.tokenUsdValue !== null && estimate.tokenUsdValue > 0 && (
              <p className="text-[10px] text-[var(--text-secondary)]">
                ≈ ${estimate.tokenUsdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
