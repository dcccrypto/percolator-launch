"use client";

import { FC, useMemo } from "react";
import { type SlabTierKey, SLAB_TIERS } from "@percolator/sdk";

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

/** Estimated transaction fees for the 5-step creation process */
const TX_FEE_ESTIMATE_SOL = 0.025; // ~5 transactions × 5000 lamports each + priority fees

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
    const dataSize = tier.dataSize;

    // Rent-exempt minimum for the slab account
    const slabRentLamports = Math.ceil((dataSize + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE);
    const slabRentSol = slabRentLamports / LAMPORTS_PER_SOL;

    // Additional rent for token accounts (vault ATA, LP mint, insurance LP mint)
    // Each token account ~165 bytes, each mint ~82 bytes
    const tokenAccountRentSol = (165 * 3 + 82 * 2) * RENT_PER_BYTE / LAMPORTS_PER_SOL;

    // Total SOL cost
    const totalSolCost = slabRentSol + tokenAccountRentSol + TX_FEE_ESTIMATE_SOL;

    // Token costs
    const lpNum = parseFloat(lpCollateral) || 0;
    const insNum = parseFloat(insuranceAmount) || 0;
    const totalTokens = lpNum + insNum;

    // USD values if price available
    const tokenUsdValue = tokenPriceUsd ? totalTokens * tokenPriceUsd : null;

    return {
      slabRentSol: slabRentSol.toFixed(4),
      tokenAccountRentSol: tokenAccountRentSol.toFixed(4),
      txFeeSol: TX_FEE_ESTIMATE_SOL.toFixed(4),
      totalSolCost: totalSolCost.toFixed(4),
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
        <h4 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[var(--text-muted)]">
          Cost Estimate
        </h4>
      </div>

      {/* SOL Costs */}
      <div className="px-4 py-3 space-y-2 border-b border-[var(--border)]">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)]">
            Slab account rent ({estimate.tierLabel}, {estimate.tierSlots} slots)
          </span>
          <span className="font-mono text-[var(--text)]">{estimate.slabRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)]">Token accounts & mints</span>
          <span className="font-mono text-[var(--text)]">{estimate.tokenAccountRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)]">Transaction fees (5 txs)</span>
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
          <span className="text-[var(--text-muted)]">LP Collateral</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.lpTokens > 0 ? estimate.lpTokens.toLocaleString() : "—"} {tokenSymbol}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)]">Insurance Fund</span>
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
              <p className="text-[10px] text-[var(--text-dim)]">
                ≈ ${estimate.tokenUsdValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
