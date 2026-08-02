import type { ValidationError } from "@/components/create/ValidationSummary";
import { MIN_LEVERAGE_X, MAX_LEVERAGE_X, BACKING_SEED_PCT_OF_LP } from "@/lib/market-params";

/**
 * Minimum LP collateral thresholds per token decimals.
 * Ensures the market has meaningful liquidity to absorb trades.
 * Values are in human-readable token amounts.
 */
const MIN_LP_COLLATERAL: Record<number, number> = {
  6: 10,     // 10 tokens for 6-decimal tokens (USDC, etc.)
  9: 0.01,   // 0.01 SOL for 9-decimal tokens
};

/** Minimum insurance fund as a percentage of LP collateral */
const MIN_INSURANCE_PCT = 5; // 5% of LP collateral

/** Maximum token decimals allowed (overflow protection) */
const MAX_DECIMALS = 12;

export interface CreateFormValues {
  mint: string;
  mintValid: boolean;
  tokenMeta: { symbol: string; name: string; decimals: number } | null;
  oracleResolved: boolean;
  oracleMode: string;
  tradingFeeBps: number;
  initialMarginBps: number;
  lpCollateral: string;
  insuranceAmount: string;
  tokenBalance: bigint | null;
  walletConnected: boolean;
  decimals: number;
}

/**
 * Comprehensive validation for the market creation form.
 * Returns all errors/warnings at once so users can fix everything before submitting.
 */
export function validateCreateForm(values: CreateFormValues): ValidationError[] {
  const errors: ValidationError[] = [];
  const {
    mint,
    mintValid,
    tokenMeta,
    oracleResolved,
    oracleMode,
    tradingFeeBps,
    initialMarginBps,
    lpCollateral,
    insuranceAmount,
    tokenBalance,
    walletConnected,
    decimals,
  } = values;

  // Wallet
  if (!walletConnected) {
    errors.push({ field: "Wallet", message: "Connect your wallet to create a market.", severity: "error" });
  }

  // Token Mint
  if (!mint) {
    errors.push({ field: "Token Mint", message: "A token mint address is required.", severity: "error" });
  } else if (!mintValid) {
    errors.push({ field: "Token Mint", message: "Invalid base58 public key.", severity: "error" });
  }

  // Decimals overflow check
  if (tokenMeta && tokenMeta.decimals > MAX_DECIMALS) {
    errors.push({
      field: "Token Decimals",
      message: `Tokens with > ${MAX_DECIMALS} decimals risk integer overflow. This token has ${tokenMeta.decimals} decimals.`,
      severity: "error",
    });
  }

  // Oracle
  if (mint && mintValid && !oracleResolved) {
    if (oracleMode === "auto") {
      errors.push({ field: "Oracle", message: "No oracle source found. Try selecting DEX Pool or Pyth mode.", severity: "error" });
    } else if (oracleMode === "pyth") {
      errors.push({ field: "Oracle", message: "A valid Pyth feed ID is required (64 hex characters).", severity: "error" });
    } else if (oracleMode === "dex") {
      errors.push({ field: "Oracle", message: "A valid DEX pool address is required.", severity: "error" });
    }
  }

  // Trading Fee
  if (tradingFeeBps < 1) {
    errors.push({ field: "Trading Fee", message: "Must be at least 1 bps.", severity: "error" });
  } else if (tradingFeeBps > 100) {
    errors.push({ field: "Trading Fee", message: "Must be 100 bps or less (1%).", severity: "error" });
  }

  // Margin. Bounds must match deriveMarketParams' clamp exactly: it silently
  // clamps leverage to [MIN_LEVERAGE_X, MAX_LEVERAGE_X], so anything the
  // validator lets through outside that range gets quietly changed instead of
  // rejected — a creator asking for 100x would have been handed a 10x market
  // with no warning. Reject here so the number they see is the number they get.
  const MAX_MARGIN_BPS = Math.ceil(10_000 / MIN_LEVERAGE_X); // 2x  -> 5000
  const MIN_MARGIN_BPS = Math.ceil(10_000 / MAX_LEVERAGE_X); // 10x -> 1000
  if (initialMarginBps < MIN_MARGIN_BPS) {
    errors.push({
      field: "Initial Margin",
      message: `Must be at least ${MIN_MARGIN_BPS} bps (${MAX_LEVERAGE_X}x max leverage).`,
      severity: "error",
    });
  } else if (initialMarginBps > MAX_MARGIN_BPS) {
    errors.push({
      field: "Initial Margin",
      message: `Must be ${MAX_MARGIN_BPS} bps or less (${MIN_LEVERAGE_X}x min leverage).`,
      severity: "error",
    });
  }

  // Fee vs Margin
  if (tradingFeeBps >= initialMarginBps) {
    errors.push({
      field: "Trading Fee",
      message: `Fee (${tradingFeeBps} bps) must be less than initial margin (${initialMarginBps} bps). A single trade would consume the entire margin.`,
      severity: "error",
    });
  }

  // LP Collateral
  const lpNum = parseFloat(lpCollateral);
  if (!lpCollateral || isNaN(lpNum) || lpNum <= 0) {
    errors.push({ field: "LP Collateral", message: "A positive LP collateral amount is required.", severity: "error" });
  } else {
    const minLp = MIN_LP_COLLATERAL[decimals] ?? 1;
    if (lpNum < minLp) {
      errors.push({
        field: "LP Collateral",
        message: `Minimum ${minLp} tokens recommended for ${decimals}-decimal tokens. Very low liquidity markets may not function properly.`,
        severity: "warning",
      });
    }
  }

  // Insurance
  const insNum = parseFloat(insuranceAmount);
  if (!insuranceAmount || isNaN(insNum) || insNum <= 0) {
    errors.push({ field: "Insurance Fund", message: "A positive insurance amount is required.", severity: "error" });
  } else if (lpNum > 0 && insNum < lpNum * MIN_INSURANCE_PCT / 100) {
    errors.push({
      field: "Insurance Fund",
      message: `Recommended at least ${MIN_INSURANCE_PCT}% of LP collateral (${(lpNum * MIN_INSURANCE_PCT / 100).toFixed(2)} tokens). Low insurance increases liquidation risk.`,
      severity: "warning",
    });
  }

  // Balance check
  if (walletConnected && tokenBalance !== null && mintValid) {
    if (tokenBalance === 0n) {
      errors.push({ field: "Token Balance", message: "You have no tokens for this mint. Use the devnet faucet to mint some.", severity: "error" });
    } else if (lpNum > 0 && insNum > 0) {
      // Compare combined amount to balance (rough check using float).
      // MUST include the backing seed: TopUpBackingBucket runs for BOTH
      // domains during the launch and pulls from the creator's wallet,
      // separately from the LP deposit. Omitting it (as this check did until
      // 2026-08-02) let a creator pass validation and then fail mid-launch,
      // and it understated the real cost by 2x the seed.
      const backingTotal = (lpNum * Number(BACKING_SEED_PCT_OF_LP)) / 100 * 2;
      const totalRequired = lpNum + insNum + backingTotal;
      const balanceFloat = Number(tokenBalance) / Math.pow(10, decimals);
      if (totalRequired > balanceFloat) {
        errors.push({
          field: "Token Balance",
          message: `You need ${totalRequired.toLocaleString()} tokens (LP ${lpNum.toLocaleString()} + insurance ${insNum.toLocaleString()} + ${backingTotal.toLocaleString()} counterparty backing) but only have ${balanceFloat.toLocaleString()}. Reduce amounts or get more tokens.`,
          severity: "error",
        });
      } else if (totalRequired > balanceFloat * 0.9) {
        errors.push({
          field: "Token Balance",
          message: "Combined LP + insurance + backing is over 90% of your balance. Consider keeping a reserve.",
          severity: "warning",
        });
      }
    }
  }

  return errors;
}
