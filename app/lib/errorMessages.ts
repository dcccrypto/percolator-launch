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
// Lighthouse v2 (Blowfish wallet guard) injects assertion IXs that fail with 0x1900
// (Anchor ConstraintAddress). This is NOT a Percolator error.
// NOTE: inlined (not imported from @/lib/tx) on purpose — errorMessages.ts is a leaf
// used by deposit/withdraw/trade/close hooks, and importing @/lib/tx pulled that heavy
// tx module into every hook test that mocks @/lib/tx, breaking them at module load.
// Keep this in sync with LIGHTHOUSE_PROGRAM_ID in @/lib/tx (same constant, two leaves).
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

// v17 PercolatorError enum — percolator-prog src/v16_program.rs (verified against
// the deployed program: Custom(N) == enum ordinal, no offset; ProgramError::Custom(value as u32)).
// This was previously a stale v12 map whose codes were misaligned from ordinal 4
// onward (e.g. 21 showed "Position size mismatch" but v17 21 = EngineLockActive).
const ERROR_CODE_MAP: Record<number, string> = {
  0: "Invalid market data (bad magic) — corrupted or not a Percolator market.",
  1: "This market uses a different program version and needs migration.",
  2: "Market already initialized.",
  3: "Market not initialized.",
  4: "Wrong account type for this action.",
  5: "Invalid account data length — corrupted account.",
  6: "Missing required signature.",
  7: "An account that must be writable was passed as read-only.",
  8: "Unauthorized — you don't have permission for this action.",
  9: "Invalid or unsupported instruction.",
  10: "Invalid mint account.",
  11: "Invalid token account.",
  12: "Invalid vault account.",
  13: "Invalid token program.",
  14: "Invalid engine configuration for this market.",
  15: "Math overflow in engine calculation — try a smaller size.",
  16: "Account provenance mismatch — wrong market or account passed.",
  17: "Position has an unsettled leg — crank the market and retry.",
  18: "Invalid position leg.",
  19: "Market data is stale — a fresh price/crank is needed. Try again in a moment.",
  20: "Counterparty (backing) state is stale — crank the market, then retry.",
  21: "This market is temporarily locked while it recovers/cranks. Try again shortly, or trade another market.",
  22: "Crank made no progress — the market may need attention. Try again shortly.",
  23: "This market is in recovery mode and must be cranked before trading resumes.",
  24: "Engine counter overflow.",
  25: "Engine counter underflow.",
  26: "Oracle is invalid — no price available for this market.",
  27: "Oracle price is stale — a fresh price must be pushed before trading. Try again in a moment.",
  28: "Oracle confidence interval too wide — price too uncertain to trade right now.",
  29: "Invalid oracle account for this market.",
  30: "An LP vault already exists for this market.",
  31: "LP vault not found for this market.",
  32: "LP vault is paused.",
  33: "LP vault still has shares outstanding — cannot proceed.",
  34: "Amount must be greater than zero.",
  35: "Insufficient LP vault shares.",
  36: "LP vault redemption cooldown is still active — wait before redeeming.",
  37: "Trade would exceed the market's open-interest cap. Try a smaller size.",
  38: "No LP vault fees available to crank yet.",
  39: "LP vault share supply mismatch — please report this error.",
  40: "LP vault authority mismatch.",
  41: "Deposit too small — it would mint zero LP shares. Deposit a larger amount.",
  42: "Position-NFT registry not found for this market.",
  43: "This position can't be transferred as an NFT right now.",
  44: "Invalid NFT transfer — cannot transfer to yourself or a zero address.",
  45: "Invalid NFT mint authority.",
  46: "Position-NFT provenance mismatch.",
  47: "Insurance withdrawal cooldown is still active.",
  48: "Insurance withdrawal exceeds the allowed ceiling (deposits-only limit).",
  49: "Insufficient margin for this trade — deposit more collateral or reduce size/leverage.",
};

/** Legacy Anchor error map (unused but kept for compatibility) */
const CUSTOM_ERROR_MAP: Record<number, string> = {};

/**
 * percolator-nft program error codes (percolator-nft/src/error.rs).
 * These overlap numerically with percolator-prog's error codes, so we must
 * route by originating program id before looking up a human message — e.g.
 * code 10 on percolator-prog is "Missing required signer" but on percolator-nft
 * it is "Slab layout not recognized".
 */
const NFT_ERROR_CODE_MAP: Record<number, string> = {
  0: "Position is not open (size is zero).",
  1: "NFT already minted for this position.",
  2: "NFT PDA does not match expected derivation — frontend/program version mismatch.",
  3: "Slab account not owned by the Percolator program.",
  4: "Slab data too short — corrupted or unsupported market.",
  5: "User index out of range for this slab.",
  6: "Position has changed since NFT was minted (entry-price mismatch).",
  7: "Only the NFT holder can burn / settle this position.",
  8: "Funding settlement overflow.",
  9: "Invalid mint authority — expected program PDA.",
  10: "NFT program cannot parse this market's slab layout — the NFT program is out of date relative to the deployed main program. An on-chain NFT program upgrade is required.",
  11: "Cannot transfer — position is being liquidated.",
  12: "Funding must be settled before transfer.",
  13: "Transfer hook: unknown Percolator program.",
  14: "Position must be fully closed (size and collateral at zero) before burn.",
  15: "Transfer hook: extra-metas PDA does not match expected derivation.",
  16: "Transfer hook: source or destination token account invalid.",
  17: "Transfer hook was invoked directly, not via Token-2022 CPI.",
  18: "This account is an LP account and cannot be wrapped as an NFT — only trading accounts are eligible.",
  19: "Account id mismatch — slot was reallocated to a different account.",
  20: "Slab slot was closed and reassigned to a different owner after this NFT was minted — the NFT no longer represents that position.",
};

/** Hard-coded NFT program id. Matches app/lib/nft-program.ts. Kept here to
 *  avoid importing the (client-only) PublicKey wrapper from this module. */
const NFT_PROGRAM_ID = "5TnritLtHS76s5iV8axqDmqhcmJKMRUekMGrk9rBTqSP";

function isNftProgramError(msg: string): boolean {
  if (msg.includes(NFT_PROGRAM_ID)) return true;
  // Our useMintPositionNft handler tags simulation failures with this prefix.
  if (msg.includes("NFT mint simulation failed")) return true;
  return false;
}

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

// Transient = worth auto-retrying (a fresh price push / crank clears it).
// v17 codes: EngineStale=19, EngineBStale=20, OracleInvalid=26, OracleStale=27.
const TRANSIENT_CODES = new Set([19, 20, 26, 27]);

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
  // v17: OracleStale=27, OracleInvalid=26, EngineStale=19, EngineBStale=20 —
  // all resolved by pushing a fresh price / cranking the market.
  return code === 27 || code === 26 || code === 19 || code === 20;
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
  // Route the code to the right per-program table. The NFT program and the
  // main Percolator program reuse the same small integers for different
  // errors, so a generic lookup would mislabel NFT errors (e.g. code 10 is
  // "Missing required signer" in the main program but "Slab layout not
  // recognized" in the NFT program — a user who sees the former assumes a
  // wallet/signing bug instead of an on-chain program mismatch).
  if (code !== null) {
    if (isNftProgramError(rawMsg) && NFT_ERROR_CODE_MAP[code]) {
      return NFT_ERROR_CODE_MAP[code];
    }
    if (ERROR_CODE_MAP[code]) {
      return ERROR_CODE_MAP[code];
    }
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
  // spl-token throws these typed errors without any .message so they bubble
  // up as the raw class name. Give each one a human sentence.
  if (rawMsg.includes("TokenAccountNotFoundError")) {
    return "Token account not found on the RPC this page is connected to. The wallet may hold the NFT from a different network, or the RPC may be out of sync — try refreshing the page.";
  }
  if (rawMsg.includes("TokenInvalidAccountOwnerError")) {
    return "Token account has the wrong on-chain owner. This usually means the frontend is pointed at a cluster where this mint was not created.";
  }
  if (rawMsg.includes("TokenInvalidMintError")) {
    return "Mint account is not a valid SPL Token / Token-2022 mint. Refresh and verify the position NFT panel still shows a valid mint.";
  }
  if (rawMsg.includes("TokenTransferHookAccountNotFound")) {
    return "Transfer-hook metadata account missing. This NFT was minted before a recent hook-fix upgrade; open a support ticket so we can run RepairExtraAccountMetas on it.";
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
