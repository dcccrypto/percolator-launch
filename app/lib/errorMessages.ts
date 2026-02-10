/**
 * Percolator program error codes (Custom(N)) → human-readable messages.
 * Maps directly to the PercolatorError enum in program/src/percolator.rs.
 */
const ERROR_CODE_MAP: Record<number, string> = {
  0: "Invalid market magic — data corrupted.",
  1: "Version mismatch or insufficient token balance. If creating an account, make sure you have tokens.",
  2: "Market already initialized.",
  3: "Market not initialized.",
  4: "Invalid slab data length — corrupted market.",
  5: "Invalid oracle key.",
  6: "Oracle price is stale — push a fresh price first.",
  7: "Oracle confidence interval too wide.",
  8: "Invalid vault token account.",
  9: "Invalid mint account.",
  10: "Missing required signer.",
  11: "Account must be writable.",
  12: "Oracle is invalid — no price available.",
  13: "Insufficient balance — deposit more collateral.",
  14: "Position would be undercollateralized at this size. Try a smaller amount or deposit more collateral.",
  15: "Unauthorized — you don't have permission for this action.",
  16: "Invalid matching engine — LP matcher mismatch.",
  17: "PnL not yet warmed up — crank the market a few more times.",
  18: "Math overflow in engine calculation.",
  19: "Account not found in this market.",
  20: "Not an LP account — invalid account kind.",
  21: "Position size mismatch — trade conflict.",
  22: "Risk reduction only mode — market is de-risking, only closing trades allowed.",
  23: "Account kind mismatch.",
  24: "Invalid token account.",
  25: "Invalid token program.",
  26: "Invalid configuration parameter.",
  27: "TradeNoCpi disabled in Hyperp mode — use TradeCpi instead.",
  28: "Insurance LP mint already exists.",
  29: "Insurance LP mint not created yet.",
  30: "Insurance fund below minimum threshold.",
  31: "Insurance deposit/withdrawal amount must be > 0.",
  32: "Insurance LP supply mismatch.",
  33: "Market is paused — trading, deposits, and withdrawals are disabled by the admin.",
};

/** Legacy Anchor error map (unused but kept for compatibility) */
const CUSTOM_ERROR_MAP: Record<number, string> = {};

function extractErrorCode(msg: string): number | null {
  const m = msg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (m) return parseInt(m[1], 16);
  // Match JSON format from getSignatureStatuses: {"Custom":14}
  const mJson = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (mJson) return parseInt(mJson[1], 10);
  const m2 = msg.match(/Custom\((\d+)\)/);
  if (m2) return parseInt(m2[1], 10) + 6000; // Anchor offset
  const m3 = msg.match(/\b0x([0-9a-fA-F]+)\b/);
  if (m3) return parseInt(m3[1], 16);
  return null;
}

function extractCustomIndex(msg: string): number | null {
  const m = msg.match(/Custom\((\d+)\)/);
  if (m) return parseInt(m[1], 10);
  // Also match JSON format: "Custom":14
  const mJson = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (mJson) return parseInt(mJson[1], 10);
  return null;
}

// Transient = worth auto-retrying (oracle stale, blockhash expiry)
const TRANSIENT_CODES = new Set([6, 12]); // OracleStale=6, OracleInvalid=12

export function isTransientError(msg: string): boolean {
  const code = extractErrorCode(msg);
  if (code !== null && TRANSIENT_CODES.has(code)) return true;
  if (msg.includes("Blockhash not found")) return true;
  if (msg.includes("block height exceeded")) return true;
  if (msg.includes("has expired")) return true;
  return false;
}

export function isOracleStaleError(msg: string): boolean {
  const code = extractErrorCode(msg);
  return code === 6 || code === 12; // OracleStale or OracleInvalid
}

export function humanizeError(rawMsg: string): string {
  // Log for debugging (only in browser)
  if (typeof window !== "undefined") {
    console.warn("[humanizeError] raw:", rawMsg);
  }

  const code = extractErrorCode(rawMsg);
  if (code !== null && ERROR_CODE_MAP[code]) {
    // Also extract which instruction failed for context
    const ixMatch = rawMsg.match(/"InstructionError"\s*:\s*\[\s*(\d+)/);
    const ixIdx = ixMatch ? parseInt(ixMatch[1], 10) : null;
    const ixLabels = ["compute budget", "priority fee", "oracle push", "crank", "trade"];
    const ixHint = ixIdx !== null && ixIdx < ixLabels.length ? ` (in ${ixLabels[ixIdx]})` : "";
    return ERROR_CODE_MAP[code] + ixHint;
  }
  const customIdx = extractCustomIndex(rawMsg);
  if (customIdx !== null && CUSTOM_ERROR_MAP[customIdx]) {
    return CUSTOM_ERROR_MAP[customIdx];
  }
  if (rawMsg.includes("Blockhash not found") || rawMsg.includes("block height exceeded") || rawMsg.includes("has expired")) {
    return "Transaction expired — network was slow. Try again, it usually works on the second attempt.";
  }
  if (rawMsg.includes("insufficient funds") || rawMsg.includes("Insufficient")) {
    return "Insufficient token balance. Deposit or mint tokens first.";
  }
  // Error code 1 can be either PercolatorError::InvalidVersion OR SPL Token InsufficientFunds from CPI
  if (rawMsg.includes("User rejected")) {
    return "Transaction cancelled.";
  }
  if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) {
    return "Transaction timed out. It may still confirm — check your wallet.";
  }
  // If we have a raw error code that wasn't recognized, show it
  if (rawMsg.includes("custom program error")) {
    return `Program error: ${rawMsg.replace(/.*custom program error:\s*/i, "").slice(0, 60)}`;
  }
  if (rawMsg.includes("Custom(")) {
    return `Program error: ${rawMsg.match(/Custom\(\d+\)/)?.[0] ?? rawMsg.slice(0, 60)}`;
  }
  // Keep last 80 chars of the raw message for debugging
  const trimmed = rawMsg.length > 80 ? "..." + rawMsg.slice(-80) : rawMsg;
  return `Transaction failed: ${trimmed}`;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, delayMs = 3000 }: { maxRetries?: number; delayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < maxRetries && isTransientError(msg)) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
