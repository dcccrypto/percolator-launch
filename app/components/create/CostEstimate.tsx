"use client";

import { FC, useMemo } from "react";
import { BACKING_SEED_PCT_OF_LP } from "@/lib/market-params";
import { wizardSlabBytes } from "@/lib/create-market-args";
import { p3WizardEnabled } from "@/lib/limits/flags";
import { VAULT_LP_MATCHER_CTX_LEN } from "@/lib/limits/constants";
import { MATCHER_CONTEXT_LEN } from "@percolatorct/sdk";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { SHARE_NAMING_NET_LAMPORTS, isShareNamingEnabled } from "@/lib/v22/share-naming";

interface CostEstimateProps {
  lpCollateral: string;
  insuranceAmount: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenPriceUsd?: number;
  className?: string;
}

/**
 * Rent-exempt minimum per account: (data bytes + 128) × lamports per byte. The rate was
 * 6960; getMinimumBalanceForRentExemption on devnet AND mainnet now returns 5080/byte
 * (0 B → 650,240; 33,900 B → 172,862,240), so 6960 over-quoted every launch by ~37%.
 * ponytail: hard-coded rate — if rent changes again, read it once from
 * getMinimumBalanceForRentExemption(0) / 128 instead.
 */
const RENT_PER_BYTE = 5080;
const RENT_OVERHEAD_BYTES = 128;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rent-exempt minimum, in SOL, for accounts of the given data sizes. */
function rentSol(...sizes: number[]): number {
  return sizes.reduce((sum, bytes) => sum + (bytes + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE, 0) / LAMPORTS_PER_SOL;
}

/** Estimated transaction fees for the ~9-10 signed-transaction creation flow (see
 *  useCreateMarket's create() for the exact sequence — bumped from 8 when the
 *  Earn vault + stake pool steps were added). */
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
const EARN_VAULT_AND_STAKE_ACCOUNT_BYTES = [176, 82, 82, 165, 352];

/**
 * W8 fix (2026-07-08): Step 2 (LP init, see useCreateMarket.ts) creates an LP
 * portfolio account (V17_PORTFOLIO_ACCOUNT_LEN — InitPortfolio
 * reallocs up to this and needs it pre-funded, so it's real client-paid rent, not
 * a later top-up) and a matcher context account (MATCHER_CONTEXT_LEN = 320 bytes).
 * Both were completely missing from every SOL-cost estimate — this file's own
 * display AND CreateMarketWizard.tsx's `requiredSol` launch gate — under-counting
 * required SOL by ~0.067 SOL. That's enough to
 * pass the pre-launch gate and then strand the user mid-flow at Step 2 with
 * "insufficient lamports."
 *
 * P3 launches also create the vault-owned LP portfolio + its matcher context
 * client-side (buildP3BindIxs in lib/limits/p3-wizard.ts).
 */
// Functions, not module constants: the portfolio length depends on the layout flag (9,563 v2.1 / 10,603 v2.2).
const lpPortfolioAndMatcherAccountBytes = (): number[] => [portfolioAccountLen(), MATCHER_CONTEXT_LEN];
const p3VaultLpAccountBytes = (): number[] => [portfolioAccountLen(), VAULT_LP_MATCHER_CTX_LEN];

export interface CreateMarketSolCostBreakdown {
  slabRentSol: number;
  tokenAccountRentSol: number;
  lpPortfolioMatcherRentSol: number;
  earnVaultStakeRentSol: number;
  txFeeSol: number;
  /**
   * v2.2 only (absent otherwise, so the flag-off breakdown is byte-identical): the Earn share token's Metaplex record, ~0.0151 SOL net
   * (the wallet briefly holds 0.03 SOL for it; the rest comes back in the same instruction).
   */
  shareNamingSol?: number;
  totalSolCost: number;
}

/**
 * W8 fix: single source of truth for the market-creation SOL cost estimate,
 * shared by this component's own display AND CreateMarketWizard's launch-gate
 * check (`requiredSol`) — see that file's BUG W8 comment. Keeping one formula
 * means the gate and the number shown to the user can never drift apart again
 * (they previously used two independently-hand-rolled formulas with different
 * TX_FEE_ESTIMATE_SOL constants on top of the missing LP-portfolio/matcher rent).
 */
export function computeCreateMarketSolCost(
  opts: { p3?: boolean } = {},
): CreateMarketSolCostBreakdown {
  // BUG 1 fix: the v17 slab account length is fixed per market kind, never per tier.
  // Every new launch, legacy and P3, encodes maxPortfolioAssets:1 (P3 because tag 94 refuses
  // anything but one slot; legacy because only slot 0 is ever used), so the slab is
  // v17MarketAccountLen(1). wizardSlabBytes is the same helper create() uses.
  const dataSize = wizardSlabBytes(opts.p3 === true);

  // Rent-exempt minimum for the slab account
  const slabRentSol = rentSol(dataSize);

  // Additional rent for token accounts (vault ATA, LP mint, insurance LP mint)
  // Each token account ~165 bytes, each mint ~82 bytes
  const tokenAccountRentSol = rentSol(165, 165, 165, 82, 82);

  // Rent for the Step 2 LP portfolio + matcher context accounts — see
  // lpPortfolioAndMatcherAccountBytes() doc comment above.
  const lpPortfolioMatcherRentSol = rentSol(
    ...lpPortfolioAndMatcherAccountBytes(),
    ...(opts.p3 === true ? p3VaultLpAccountBytes() : []),
  );

  // Rent for the Earn vault (Step 4) + stake pool (Step 5) accounts — see
  // EARN_VAULT_AND_STAKE_ACCOUNT_BYTES doc comment above.
  const earnVaultStakeRentSol = rentSol(...EARN_VAULT_AND_STAKE_ACCOUNT_BYTES);

  // v2.2: naming the Earn share token (tag 122) costs the Metaplex record's rent + create fee.
  const shareNamingSol = isShareNamingEnabled() ? SHARE_NAMING_NET_LAMPORTS / LAMPORTS_PER_SOL : null;

  const totalSolCost =
    slabRentSol + tokenAccountRentSol + lpPortfolioMatcherRentSol + earnVaultStakeRentSol + TX_FEE_ESTIMATE_SOL + (shareNamingSol ?? 0);

  return {
    slabRentSol,
    tokenAccountRentSol,
    lpPortfolioMatcherRentSol,
    earnVaultStakeRentSol,
    txFeeSol: TX_FEE_ESTIMATE_SOL,
    ...(shareNamingSol !== null ? { shareNamingSol } : {}),
    totalSolCost,
  };
}

/**
 * Detailed cost breakdown for market creation.
 * Shows rent costs, token requirements, and transaction fees.
 */
export const CostEstimate: FC<CostEstimateProps> = ({
  lpCollateral,
  insuranceAmount,
  tokenSymbol,
  tokenDecimals,
  tokenPriceUsd,
  className = "",
}) => {
  const estimate = useMemo(() => {
    const sol = computeCreateMarketSolCost({ p3: p3WizardEnabled() });

    // Token costs.
    // W11 fix (2026-07-08): useCreateMarket.ts no longer transfers a 500-token vault
    // seed before InitMarket (launch-test-market.ts, the proven 8/8 reference, never
    // seeds the vault and succeeds — the engine doesn't require or account for it).
    // Showing a "Vault Seed (required)" line here would now be actively wrong —
    // dropped; total tokens required is just LP collateral + insurance.
    const lpNum = parseFloat(lpCollateral) || 0;
    const insNum = parseFloat(insuranceAmount) || 0;
    // Counterparty backing (2026-08-02): TopUpBackingBucket runs for BOTH
    // domains during the launch, pulling from the creator's wallet on top of
    // the LP deposit. This line was missing entirely, so the quoted total
    // understated the real cost and a creator could start a launch they could
    // not finish. See BACKING_SEED_PCT_OF_LP in lib/market-params.ts for why
    // the seed is sized at the LP's full collateral.
    const backingTokens = (lpNum * Number(BACKING_SEED_PCT_OF_LP)) / 100 * 2;
    const totalTokens = lpNum + insNum + backingTokens;

    // Collateral (LP + insurance) is the universal Sim-USDC mint — 1:1 with USD,
    // NOT the launched token. Value it at $1 each, not the token's price.
    const tokenUsdValue = totalTokens;

    return {
      slabRentSol: sol.slabRentSol.toFixed(4),
      tokenAccountRentSol: sol.tokenAccountRentSol.toFixed(4),
      lpPortfolioMatcherRentSol: sol.lpPortfolioMatcherRentSol.toFixed(4),
      earnVaultStakeRentSol: sol.earnVaultStakeRentSol.toFixed(4),
      txFeeSol: sol.txFeeSol.toFixed(4),
      shareNamingSol: sol.shareNamingSol === undefined ? null : sol.shareNamingSol.toFixed(4),
      totalSolCost: sol.totalSolCost.toFixed(4),
      lpTokens: lpNum,
      insTokens: insNum,
      backingTokens,
      totalTokens,
      tokenUsdValue,
      dataSize: wizardSlabBytes(p3WizardEnabled()),
      tokenDecimals,
    };
  }, [lpCollateral, insuranceAmount, tokenPriceUsd, tokenDecimals]);

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
          {/* v17 slabs are always sized to max capacity — there is no tier to
              display here (see LAUNCH_ASSET_SLOTS in lib/create-market-args.ts). */}
          <span className="text-[var(--text-secondary)]">
            Market account rent
          </span>
          <span className="font-mono text-[var(--text)]">{estimate.slabRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Token accounts & mints</span>
          <span className="font-mono text-[var(--text)]">{estimate.tokenAccountRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Liquidity account rent</span>
          <span className="font-mono text-[var(--text)]">{estimate.lpPortfolioMatcherRentSol} SOL</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Earn vault & stake pool</span>
          <span className="font-mono text-[var(--text)]">{estimate.earnVaultStakeRentSol} SOL</span>
        </div>
        {estimate.shareNamingSol !== null && (
          <div className="flex items-center justify-between text-[11px]" data-testid="cost-share-naming">
            <span className="text-[var(--text-secondary)]">Earn share token name</span>
            <span className="font-mono text-[var(--text)]">{estimate.shareNamingSol} SOL</span>
          </div>
        )}
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
          <span className="text-[var(--text-secondary)]">Starting liquidity</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.lpTokens > 0 ? estimate.lpTokens.toLocaleString() : "—"} Sim-USDC
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-secondary)]">Insurance Fund</span>
          <span className="font-mono text-[var(--text)]">
            {estimate.insTokens > 0 ? estimate.insTokens.toLocaleString() : "—"} Sim-USDC
          </span>
        </div>
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <span className="text-[11px] font-semibold text-[var(--text)]">Total Collateral Required</span>
          <div className="text-right">
            <span className="text-[13px] font-bold font-mono text-[var(--text)]">
              {estimate.totalTokens > 0 ? estimate.totalTokens.toLocaleString() : "—"} Sim-USDC
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
