/** Solana program error code → human-readable message */
const ERROR_CODE_MAP: Record<number, string> = {
  0x4: "Market data is invalid or corrupted.",
  0xc: "Price feed is stale — the oracle hasn't updated recently. Try again in a moment.",
  0xd: "Insufficient balance — deposit more collateral.",
  0xe: "Position would be undercollateralized at this size.",
  0xf: "Unauthorized — you don't have permission for this action.",
};

/** Anchor / program Custom(N) errors — instruction-specific */
const CUSTOM_ERROR_MAP: Record<number, string> = {
  0: "Generic program error.",
  1: "Invalid instruction data.",
  2: "Invalid account data.",
  3: "Account not initialized.",
  4: "Account already initialized.",
  5: "Signer required but missing.",
  6: "Not enough accounts provided.",
  7: "Account type mismatch.",
  8: "Math overflow in calculation.",
  9: "Invalid market state.",
  10: "Market is paused — trading temporarily disabled.",
  11: "Market is settling — no new trades allowed.",
  12: "Oracle price is stale.",
  13: "Insufficient collateral.",
  14: "Position too large for current liquidity.",
  15: "Invalid leverage — exceeds maximum allowed.",
  16: "Position does not exist.",
  17: "Cannot close — pending settlement.",
  18: "Funding rate calculation error.",
  19: "Invalid fee configuration.",
  20: "LP pool imbalanced — try a smaller size.",
  21: "Keeper crank required first.",
  22: "Invalid oracle account.",
  23: "Price deviation too high — oracle price differs significantly from last trade.",
  24: "Cooldown active — wait before trading again.",
  25: "Account is frozen by admin.",
  26: "Invalid slab configuration.",
};

function extractErrorCode(msg: string): number | null {
  const m = msg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (m) return parseInt(m[1], 16);
  const m2 = msg.match(/Custom\((\d+)\)/);
  if (m2) return parseInt(m2[1], 10) + 6000; // Anchor offset
  const m3 = msg.match(/\b0x([0-9a-fA-F]+)\b/);
  if (m3) return parseInt(m3[1], 16);
  return null;
}

function extractCustomIndex(msg: string): number | null {
  const m = msg.match(/Custom\((\d+)\)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

const TRANSIENT_CODES = new Set([0xc]);

export function isTransientError(msg: string): boolean {
  const code = extractErrorCode(msg);
  if (code !== null && TRANSIENT_CODES.has(code)) return true;
  if (msg.includes("Blockhash not found")) return true;
  if (msg.includes("block height exceeded")) return true;
  if (msg.includes("has expired")) return true;
  return false;
}

export function isOracleStaleError(msg: string): boolean {
  return extractErrorCode(msg) === 0xc;
}

export function humanizeError(rawMsg: string): string {
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
  if (rawMsg.includes("insufficient funds") || rawMsg.includes("Insufficient")) {
    return "Insufficient funds for this transaction.";
  }
  if (rawMsg.includes("User rejected")) {
    return "Transaction cancelled.";
  }
  if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) {
    return "Transaction timed out. It may still confirm — check your wallet.";
  }
  return "Transaction failed. Please try again.";
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
