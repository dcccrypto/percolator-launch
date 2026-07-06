/**
 * Parse Solana transaction errors into user-friendly messages for market creation.
 * Covers common failure modes: insufficient balance, user rejection, network errors,
 * and Percolator program-specific error codes.
 */

import { decodeError } from "@percolatorct/sdk";

// v17 error codes are sourced from the SDK (PERCOLATOR_ERRORS in @percolatorct/sdk).
// The SDK exports decodeError(code) → { name, hint } | undefined for codes 0-46.
// This local map is kept for error codes that need launch-specific user messages
// (e.g. code 5 — InvalidAccountLen — gets a slab-tier-specific message).
// All other codes fall through to decodeError() for the SDK hint.
const LAUNCH_ERROR_OVERRIDES: Record<number, string> = {
  // 0: InvalidMagic
  0: "Invalid magic number. The market account data is corrupted. Check the market address.",
  // 1: InvalidVersion
  1: "Account version mismatch (expected v17). The program may need upgrading or the market was created with an older program.",
  // 2: AlreadyInitialized
  2: "Market is already initialized. Cannot re-initialize.",
  // 3: NotInitialized
  3: "Market is not initialized. The slab account may not have been set up correctly.",
  // 4: InvalidAccountKind
  4: "Wrong account kind. A market group, portfolio, or insurance-ledger address was used in the wrong position.",
  // 5: InvalidAccountLen — include slab-tier guidance
  5: "Invalid account length. This market uses an incompatible account size — it may have been created with an older program version. " +
     "The market may need re-initialization by the market creator, or try a different slab tier.",
  // 8: Unauthorized
  8: "Not authorized for this operation. Ensure the correct authority wallet (marketauth or asset_admin) is connected.",
  // 15: EngineArithmeticOverflow
  15: "Math overflow — values are too large for safe computation. Try a smaller amount or position size.",
  // 16: EngineProvenanceMismatch
  16: "Portfolio provenance mismatch. This portfolio was not created for this market group.",
  // 18: EngineInvalidLeg
  18: "Invalid trade leg. Check asset_index and size parameters.",
  // 19: EngineStale — direct user action
  19: "Market is stale. A permissionless crank was prepended to your transaction — retry or wait a few seconds for the oracle to update.",
};

export function parseMarketCreationError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);

  // User rejected the transaction in their wallet
  if (
    msg.includes("User rejected") ||
    msg.includes("user rejected") ||
    msg.includes("Transaction cancelled") ||
    msg.includes("WalletSignTransactionError")
  ) {
    return "Transaction cancelled — you rejected the signing request in your wallet. Click Retry to try again.";
  }

  // Insufficient SPL token balance (token program error 0x1 or transfer failure).
  // Must be checked BEFORE the SOL/lamports branch — Solana simulation errors for
  // token transfers also include "insufficient funds" but are not a SOL problem. Fixes #758.
  if (
    msg.includes("insufficient funds for transfer") ||
    (msg.includes("insufficient funds") && !msg.includes("lamports") && !msg.includes("for rent")) ||
    (msg.includes("custom program error: 0x1") && msg.includes("TokenkegQ"))
  ) {
    return "Insufficient token balance. Your wallet doesn't have enough collateral tokens to complete this step. On devnet, refresh the page and retry — the faucet will top up your balance.";
  }

  // Insufficient SOL for rent/fees
  if (
    msg.includes("Attempt to debit an account but found no record of a prior credit") ||
    msg.includes("insufficient lamports") ||
    msg.includes("insufficient funds")
  ) {
    return "Insufficient SOL balance. You need enough SOL to cover the slab rent and transaction fees. Check your wallet balance.";
  }

  // Account already exists (slab already created in a previous attempt)
  if (msg.includes("already in use")) {
    return "The slab account already exists from a previous attempt. Click Retry to continue from the current step.";
  }

  // Transaction too large
  if (msg.includes("Transaction too large") || msg.includes("transaction too large")) {
    return "Transaction is too large. Try selecting a smaller slab tier (fewer trader slots).";
  }

  // Blockhash expired (tx took too long)
  if (
    msg.includes("block height exceeded") ||
    msg.includes("Blockhash not found") ||
    msg.includes("blockhash")
  ) {
    return "Transaction expired before confirmation. The network may be congested. Click Retry to try again.";
  }

  // Simulation failed — try to extract program error.
  // Use launch-specific overrides first, then SDK decodeError() for v17 codes 0-46.
  if (msg.includes("custom program error")) {
    const match = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      const override = LAUNCH_ERROR_OVERRIDES[code];
      if (override) return override;
      const sdkErr = decodeError(code);
      if (sdkErr) return `${sdkErr.hint}`;
      return `Program error (code ${code}). The on-chain program rejected the transaction.`;
    }
  }

  // InstructionError with index
  if (msg.includes("InstructionError")) {
    const match = msg.match(/InstructionError.*?(\d+).*?Custom.*?(\d+)/);
    if (match) {
      const code = parseInt(match[2]);
      const override = LAUNCH_ERROR_OVERRIDES[code];
      if (override) return `Step failed: ${override}`;
      const sdkErr = decodeError(code);
      if (sdkErr) return `Step failed: ${sdkErr.hint}`;
    }
  }

  // Network/RPC errors
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED")) {
    return "Network error — cannot reach Solana RPC. Check your internet connection and try again.";
  }

  // Timeout
  if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("ETIMEDOUT")) {
    return "Request timed out. The Solana network may be congested. Click Retry to try again.";
  }

  // Wallet not connected
  if (msg.includes("Wallet not connected") || msg.includes("wallet adapter")) {
    return "Wallet disconnected. Please reconnect your wallet and try again.";
  }

  // Fallback: truncate long messages but keep them informative
  if (msg.length > 200) {
    return `Transaction failed: ${msg.slice(0, 180)}... Click Retry or Start Over.`;
  }

  return `Transaction failed: ${msg}`;
}
