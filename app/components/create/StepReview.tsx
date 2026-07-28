"use client";

import { FC, useMemo } from "react";
import { type SlabTierKey, SLAB_TIERS } from "@/lib/slabTiers";
import { CostEstimate } from "./CostEstimate";
import Link from "next/link";
import { getNetwork } from "@/lib/config";
import { flooredInitialMarginBps } from "@/hooks/useCreateMarket";
import { leverageFromMarginBps } from "@/lib/market-params";

interface StepReviewProps {
  // Token
  tokenSymbol: string;
  tokenName: string;
  mintAddress: string;
  tokenDecimals: number;
  priceUsd?: number;
  mintValid: boolean;
  mintExistsOnNetwork: boolean;
  // Oracle
  oracleType: "pyth" | "hyperp_ema" | "admin" | "keeper";
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
  /**
   * GH#1117: True only when the token is a Percolator-managed devnet mirror
   * (Percolator = mint authority). False for custom tokens (user = mint authority).
   * Controls whether the "tokens auto-airdropped" promise is shown at Review.
   */
  isPercolatorMirror?: boolean;
  // Actions
  onBack: () => void;
  onLaunch: () => void;
  canLaunch: boolean;
}

interface TxStep {
  label: string;
  detail: string;
  /** "tx" = a signed Solana transaction (costs a base fee); "signature" = an off-chain
   *  wallet signature (signMessage), no SOL cost. Used to keep the summary line below
   *  the list accurate about how many on-chain transactions vs. signatures are involved. */
  kind: "tx" | "signature";
}

/**
 * BUG 17 fix (2026-07-06): regenerated from the ACTUAL send sequence in
 * useCreateMarket.ts's create() — previously this was a stale 5-item list (including an
 * "Insurance LP mint" step that was removed; see create()'s "Insurance LP mint creation
 * removed — moved to percolator-stake program" note) while the real happy path fires 7
 * signed transactions.
 *
 * Updated again when the Earn vault (Step 4) + stake pool (Step 5) were added to give
 * wizard-created markets full parity with the 5 seeded markets (see the Step 4/5 doc
 * comment in useCreateMarket.ts's create() for the marketauth-ordering rationale — the
 * stake pool step is deliberately last, since it rotates on-chain marketauth away from
 * the creator wallet). The happy path now fires 9 signed transactions:
 *   1. createAccount(slab) + createATA(vault) + seed transfer + InitMarket   (atomic)
 *   2. SetNftProgramId (registers the per-market NFT registry; v17 has no separate
 *      oracle-setup/pre-LP crank step — that's embedded in InitMarket)
 *   3. createAccount(LP portfolio) + InitPortfolio
 *   4. createAccount(matcher context account)
 *   5. SetMatcherConfig (on the LP portfolio)
 *   6. InitMatcherCtx (wrapper CPIs into the matcher program)
 *   7. DepositCollateral + TopUpInsurance + final PermissionlessCrank
 *   8. CreateLpVault (Earn vault — no forced initial deposit, see Step 4 doc comment)
 *   9. createAccount(stake lpMint) + createAccount(stake vault) + Stake InitPool (atomic;
 *      rotates on-chain marketauth to the stake pool PDA)
 * ...plus one off-chain wallet.signMessage() (nonce sign for the /api/markets dashboard
 * registration POST, GH#1761/PERC-8332) — not a transaction, no SOL cost, but still a
 * wallet approval the user will see.
 */
const BASE_TX_STEPS: readonly TxStep[] = [
  { label: "Create slab & initialize market", detail: "Atomic — rolls back if any part fails", kind: "tx" },
  { label: "Register NFT program", detail: "Creates this market's Position NFT registry", kind: "tx" },
  { label: "Create LP portfolio", detail: "Opens the market-maker liquidity account", kind: "tx" },
  { label: "Create matcher context account", detail: "Allocates on-chain matcher state", kind: "tx" },
  { label: "Configure matcher", detail: "Attaches matcher config to the LP portfolio", kind: "tx" },
  { label: "Initialize matcher context", detail: "Activates passive market-making", kind: "tx" },
  { label: "Deposit, insurance & finalize", detail: "Seed capital + insurance fund + final crank", kind: "tx" },
  { label: "Create Earn vault", detail: "Opens this market's LP vault for depositors", kind: "tx" },
  { label: "Initialize stake pool", detail: "Final step — hands market governance to the stake pool", kind: "tx" },
  { label: "Sign market registration", detail: "Off-chain signature — lists the market on the dashboard, no SOL cost", kind: "signature" },
] as const;

/**
 * Keeper-oracle markets (oracleType === "keeper") insert one extra signed transaction
 * between steps 1 and 2 — the creator co-signs alongside the keeper to delegate oracle
 * authority (see useCreateMarket.ts's ConfigureAuthMark + UpdateAssetAuthority block).
 */
const KEEPER_COSIGN_STEP: TxStep = {
  label: "Delegate oracle authority to keeper",
  detail: "Keeper co-signs; you approve the delegation",
  kind: "tx",
};

/**
 * Step 4 — Review & Confirm.
 * Market preview, cost breakdown, transaction steps, and launch button.
 */
export const StepReview: FC<StepReviewProps> = ({
  tokenSymbol,
  tokenName,
  mintAddress,
  tokenDecimals,
  mintValid,
  mintExistsOnNetwork,
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
  isPercolatorMirror = false,
  onBack,
  onLaunch,
  canLaunch,
}) => {
  // BUG 16 fix: preview the FLOORED margin (MIN_SAFE_INITIAL_MARGIN_BPS applies inside
  // create()) so what's shown here matches what actually lands on-chain — previously this
  // showed unfloored leverage (e.g. "10x") for a market that would be created at ~6.67x.
  const maxLeverage = leverageFromMarginBps(flooredInitialMarginBps(initialMarginBps));
  const tier = SLAB_TIERS[slabTier];

  // BUG 17 fix: keeper-oracle markets fire one extra signed tx (oracle authority
  // delegation) between steps 1 and 2 — see KEEPER_COSIGN_STEP doc comment above.
  const txSteps = useMemo<readonly TxStep[]>(() => {
    if (oracleType !== "keeper") return BASE_TX_STEPS;
    return [BASE_TX_STEPS[0], KEEPER_COSIGN_STEP, ...BASE_TX_STEPS.slice(1)];
  }, [oracleType]);
  const onChainTxCount = txSteps.filter((s) => s.kind === "tx").length;
  const signatureCount = txSteps.length - onChainTxCount;

  const oracleTypeLabel =
    oracleType === "pyth"
      ? "Pyth"
      : oracleType === "hyperp_ema"
        ? "HyperpEMA"
        : oracleType === "keeper"
          ? "Keeper"
          : "Admin";

  const isDevnet = getNetwork() === "devnet";

  // GH#1301: mirrors CreateMarketWizard skipTokenBalanceCheck logic.
  // Token balance check is skipped only for Percolator-managed mirror mints on devnet
  // (tokens auto-airdropped post-creation). Custom tokens and native-SOL collateral markets
  // still require sufficient token balance.
  const skipTokenBalanceCheck = isDevnet && isPercolatorMirror;

  const launchButtonLabel = useMemo(() => {
    if (!walletConnected) return "Connect Wallet to Launch";
    if (!mintValid) return "❌ Invalid Mint Address";
    if (!mintExistsOnNetwork) return "❌ Mint Not Found on Network";
    if (!skipTokenBalanceCheck && !hasTokens) return "No Tokens — Mint First";
    if (!skipTokenBalanceCheck && !hasSufficientTokensForSeed) return "Insufficient Tokens — Check Wallet Balance";
    if (feeConflict) return "Fix Parameters to Continue";
    if (!hasSufficientBalance) return "Insufficient SOL";
    if (isDevnet) return isPercolatorMirror ? "LAUNCH & MINT TOKENS →" : "LAUNCH MARKET →";
    return "LAUNCH MARKET →";
  }, [walletConnected, mintValid, mintExistsOnNetwork, hasTokens, hasSufficientTokensForSeed, feeConflict, hasSufficientBalance, isDevnet, isPercolatorMirror, skipTokenBalanceCheck]);

  return (
    <div className="space-y-5">
      {/* Mint validation status */}
      {!mintValid && (
        <div className="p-3 bg-red-500/20 border border-red-500 rounded text-red-500 text-sm">
          ❌ Invalid mint address: &quot;{mintAddress}&quot;
        </div>
      )}
      {mintValid && !mintExistsOnNetwork && (
        <div className="p-3 bg-yellow-500/20 border border-yellow-500 rounded text-yellow-500 text-sm">
          ⚠️ Mint not found on {getNetwork() === "devnet" ? "devnet" : "mainnet"}
        </div>
      )}
      {mintValid && mintExistsOnNetwork && (
        <div className="p-3 bg-green-500/20 border border-green-500 rounded text-green-500 text-sm">
          ✅ Mint verified on {getNetwork() === "devnet" ? "devnet" : "mainnet"}
        </div>
      )}

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
                  style={{ fontFamily: "var(--font-display)" }}
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

      {/* Balance check */}
      {walletConnected && walletBalanceSol !== null && (
        <div className="flex items-center gap-2 text-[11px]">
          {hasSufficientBalance ? (
            <>
              <span className="text-[var(--long)]">✓</span>
              <span className="text-[var(--text-secondary)]">
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

      {/* Devnet: token funding info — differs by mint authority (GH#1117) */}
      {walletConnected && isDevnet && isPercolatorMirror && (
        <div className="border border-[var(--long)]/20 bg-[var(--long)]/[0.04] px-4 py-3 space-y-1">
          <p className="text-[11px] text-[var(--text)]">
            <span className="text-[var(--long)] font-medium">✓ Devnet mode.</span>{" "}
            Your wallet will receive devnet {tokenSymbol} tokens automatically after the market is created.
          </p>
          <p className="text-[9px] text-[var(--text-secondary)]">
            No tokens needed upfront — tokens are airdropped post-launch for testing.
          </p>
        </div>
      )}
      {walletConnected && isDevnet && !isPercolatorMirror && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] px-4 py-3 space-y-1">
          <p className="text-[11px] text-[var(--text)]">
            <span className="text-[var(--accent)] font-medium">ℹ Custom token.</span>{" "}
            You are the mint authority — tokens will not be auto-airdropped.
          </p>
          <p className="text-[9px] text-[var(--text-secondary)]">
            After launch, mint tokens from your wallet and deposit them into the vault to enable trading.
          </p>
        </div>
      )}

      {/* Transaction Steps */}
      <div>
        <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)]">
          Transaction Steps
        </p>
        <div className="border border-[var(--border)] bg-[var(--bg)] px-4 py-3 space-y-2">
          {txSteps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-[12px]">
              <span className="text-[10px] font-mono text-[var(--text-secondary)] mt-0.5 flex-shrink-0">{i + 1}.</span>
              <div className="min-w-0">
                <span className="text-[var(--text)]">{step.label}</span>
                {step.kind === "signature" && (
                  <span className="ml-1.5 border border-[var(--border)] px-1 py-0.5 text-[8px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
                    off-chain
                  </span>
                )}
                <span className="hidden sm:inline text-[10px] text-[var(--text-secondary)] ml-2">
                  — {step.detail}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
          {onChainTxCount} transaction{onChainTxCount === 1 ? "" : "s"}
          {signatureCount > 0 ? ` + ${signatureCount} wallet signature${signatureCount === 1 ? "" : "s"}` : ""} — each requires approval.
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
          disabled={!canLaunch || !mintValid || !mintExistsOnNetwork}
          className="flex-1 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3.5 text-[14px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-secondary)]"
        >
          {launchButtonLabel}
        </button>
      </div>
    </div>
  );
};
