/**
 * Parse Solana transaction errors into user-friendly messages for market creation.
 * Covers common failure modes: insufficient balance, user rejection, network errors,
 * and Percolator program-specific error codes.
 */

// Percolator program custom error codes (from percolator-prog/src/percolator.rs)
// Error codes are the 0-indexed ordinal of each variant in the PercolatorError enum.
// WARNING: This mapping MUST stay in sync with the enum in percolator-prog/src/percolator.rs.
// Run `grep -n 'pub enum PercolatorError' percolator-prog/src/percolator.rs` if unsure.
const PERCOLATOR_ERRORS: Record<number, string> = {
  0:  "Invalid magic bytes — the slab account is not a Percolator market.",
  1:  "Invalid program version — a program upgrade may be required.",
  2:  "Market is already initialized. Cannot re-initialize.",
  3:  "Market is not initialized. The slab account may be corrupted.",
  4:  "Invalid slab length — the account size doesn't match the compiled program. " +
      "On devnet, try using the Large slab tier (Small/Medium programs may need redeployment).",
  5:  "Invalid oracle key.",
  6:  "Oracle price is stale.",
  7:  "Oracle confidence too wide.",
  8:  "Invalid vault ATA — the vault's token account does not match the expected address.",
  9:  "Invalid mint — the collateral mint does not match.",
  10: "Expected a signer account.",
  11: "Expected a writable account.",
  12: "Oracle price is invalid.",
  13: "Insufficient balance to complete this operation.",
  14: "Position is undercollateralized.",
  15: "Unauthorized — caller is not the admin or oracle authority.",
  16: "Invalid matching engine.",
  17: "PnL not warmed up — wait for the warmup period to complete.",
  18: "Math overflow — values are too large.",
  19: "Account not found in the market.",
  20: "Account is not an LP account.",
  21: "Position size mismatch.",
  22: "Risk reduction only mode — no new positions allowed.",
  23: "Account kind mismatch.",
  24: "Invalid token account.",
  25: "Invalid token program.",
  26: "Invalid config parameter.",
  33: "Market is paused by admin.",
  36: "Insufficient seed deposit. The vault needs at least 500 tokens before market initialization.",
  37: "Insufficient DEX liquidity — the pool does not have enough reserves for a safe Hyperp oracle.",
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

  // Simulation failed — try to extract program error
  if (msg.includes("custom program error")) {
    const match = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      const friendly = PERCOLATOR_ERRORS[code];
      if (friendly) return friendly;
      return `Program error (code ${code}). The on-chain program rejected the transaction.`;
    }
  }

  // InstructionError with index
  if (msg.includes("InstructionError")) {
    const match = msg.match(/InstructionError.*?(\d+).*?Custom.*?(\d+)/);
    if (match) {
      const code = parseInt(match[2]);
      const friendly = PERCOLATOR_ERRORS[code];
      if (friendly) return `Step failed: ${friendly}`;
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
