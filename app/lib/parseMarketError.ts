/**
 * Parse Solana transaction errors into user-friendly messages for market creation.
 * Covers common failure modes: insufficient balance, user rejection, network errors,
 * and Percolator program-specific error codes.
 */

// Percolator program custom error codes (from percolator-prog/src/percolator.rs)
const PERCOLATOR_ERRORS: Record<number, string> = {
  0: "Market is already initialized. Cannot re-initialize.",
  1: "Market is not initialized. The slab account may be corrupted.",
  2: "Invalid slab length. The account size doesn't match the program.",
  3: "Account not found in the market.",
  4: "Insufficient balance to complete this operation.",
  5: "Math overflow — values are too large.",
  6: "Margin requirement not met. Increase collateral.",
  7: "Invalid version — program upgrade may be needed.",
  8: "Insufficient seed deposit. The vault needs at least 500 USDC before market initialization.",
  9: "Market is paused by admin.",
  10: "Oracle price is invalid or stale.",
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

  // Insufficient SOL for rent/fees
  if (
    msg.includes("Attempt to debit an account but found no record of a prior credit") ||
    msg.includes("insufficient funds") ||
    msg.includes("insufficient lamports")
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
