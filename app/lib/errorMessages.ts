/**
 * Percolator on-chain program error code to human-readable message mappings.
 * 
 * Provides user-friendly explanations for blockchain transaction errors returned by the Percolator program.
 * Each numeric code maps 1:1 to the PercolatorError enum defined in program/src/percolator.rs.
 * 
 * Used by:
 * - API error responses (translateProgram Errors)
 * - Frontend error dialogs
 * - Transaction simulation to predict failures
 * 
 * When a Solana transaction fails with a Percolator custom error, the error code number
 * is extracted and looked up here to display context-appropriate text to the user.
 */
// ── Lighthouse/Blowfish detection (PERC-8445) ──────────────────────────────
// Inlined from @percolator/sdk runtime/lighthouse.ts to avoid workspace sync issues.
// Lighthouse v2 (Blowfish wallet guard) injects assertion IXs that fail with 0x1900
// (Anchor ConstraintAddress). This is NOT a Percolator error.
const LIGHTHOUSE_PROGRAM_ID_STR = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const LIGHTHOUSE_USER_MESSAGE =
  "Your wallet's transaction guard (Blowfish/Lighthouse) is blocking this transaction. " +
  "This is a known compatibility issue — the transaction itself is valid. " +
  "Try one of these workarounds:\n" +
  "1. Disable transaction simulation in your wallet settings\n" +
  "2. Use a wallet without Blowfish protection (e.g., Backpack, Solflare)\n" +
  "3. The SDK will automatically retry without the guard";

function isLighthouseError(msg: string): boolean {
  if (msg.includes(LIGHTHOUSE_PROGRAM_ID_STR)) return true;
  if (/custom\s+program\s+error:\s*0x1900\b/i.test(msg)) return true;
  if (/"Custom"\s*:\s*6400\b/.test(msg) && /InstructionError/i.test(msg)) return true;
  return false;
}

export { LIGHTHOUSE_USER_MESSAGE };

const ERROR_CODE_MAP: Record<number, string> = {
  0: "Invalid market magic — data corrupted.",
  1: "This market was created with an older program version and needs migration. The program has been upgraded — please contact the market admin to migrate this market, or create a new market with the current program.",
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
  14: "Undercollateralized — either your margin is too low or the market's LP has insufficient capital. Try a smaller amount, deposit more collateral, or contact the market admin.",
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
  34: "Cannot renounce admin — the market must be resolved first.",
  35: "Invalid confirmation code for admin renouncement.",
  36: "Vault seed balance too low — deposit more tokens to the vault before creating the market.",
  37: "DEX pool has insufficient liquidity for safe oracle bootstrapping.",
  38: "LP vault already exists for this market.",
  39: "LP vault not yet created — create it first.",
  40: "LP vault amount must be greater than zero.",
  41: "LP vault supply/capital mismatch — please report this error.",
  42: "LP vault withdrawal exceeds available capital (some is reserved for open interest).",
  43: "LP vault fee share out of range (must be 0–100%).",
  44: "No new fees to distribute to LP vault yet.",
};

/** Legacy Anchor error map (unused but kept for compatibility) */
const CUSTOM_ERROR_MAP: Record<number, string> = {};

function extractErrorCode(msg: string): number | null {
  const m = msg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (m) return parseInt(m[1], 16);
  // Match JSON format from getSignatureStatuses: {"Custom":14}
  const mJson = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (mJson) return parseInt(mJson[1], 10);
  // Percolator is NOT Anchor — no +6000 offset. Custom(N) maps directly to ERROR_CODE_MAP.
  const m2 = msg.match(/Custom\((\d+)\)/);
  if (m2) return parseInt(m2[1], 10);
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

  // PERC-8445: Lighthouse/Blowfish detection MUST run before generic hex extraction.
  // 0x1900 is Anchor ConstraintAddress from Lighthouse, NOT a Percolator error code.
  if (isLighthouseError(rawMsg)) {
    return LIGHTHOUSE_USER_MESSAGE;
  }

  // Handle Solana system errors BEFORE custom code extraction.
  // These are string-form errors like "InvalidAccountData", "AccountAlreadyInitialized" etc.
  // They must NOT be confused with Percolator custom program error codes.
  if (rawMsg.includes('"InvalidAccountData"')) {
    return "Invalid account data — one of the accounts has unexpected data. The transaction may need different accounts or the market state may have changed.";
  }
  if (rawMsg.includes('"AccountAlreadyInitialized"')) {
    return "Account already exists — this operation was already completed.";
  }
  if (rawMsg.includes('"AccountNotFound"') || rawMsg.includes("AccountNotFound")) {
    return "Account not found on-chain. It may have been closed or not yet created.";
  }
  if (rawMsg.includes("insufficient account keys")) {
    return "Missing accounts in transaction — this is likely a frontend bug. Please report it.";
  }

  const code = extractErrorCode(rawMsg);
  if (code !== null && ERROR_CODE_MAP[code]) {
    return ERROR_CODE_MAP[code];
  }
  const customIdx = extractCustomIndex(rawMsg);
  if (customIdx !== null && CUSTOM_ERROR_MAP[customIdx]) {
    return CUSTOM_ERROR_MAP[customIdx];
  }
  if (rawMsg.includes("Blockhash not found") || rawMsg.includes("block height exceeded") || rawMsg.includes("has expired")) {
    return "Transaction expired — network was slow. Try again, it usually works on the second attempt.";
  }
  if (rawMsg.includes("Insufficient SOL")) {
    return rawMsg; // Already a clear message from our pre-flight check
  }
  if (rawMsg.includes("insufficient funds") || rawMsg.includes("Insufficient")) {
    return "Insufficient balance for transaction fees. Ensure you have enough SOL for fees and enough tokens for the trade.";
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
