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
  "This is a known compatibility issue - the transaction itself is valid. " +
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
  0: "Invalid market data (bad magic) - corrupted or not a Percolator market.",
  1: "This market uses a different program version and needs migration.",
  2: "Market already initialized.",
  3: "Market not initialized.",
  4: "Wrong account type for this action.",
  5: "Invalid account data length - corrupted account.",
  6: "Missing required signature.",
  7: "An account that must be writable was passed as read-only.",
  8: "Unauthorized - you don't have permission for this action.",
  9: "Invalid or unsupported instruction. (If this is a market order, the market's matcher config may be misaligned on-chain. Please report this to the team.)",
  10: "Invalid mint account.",
  11: "Invalid token account.",
  12: "Invalid vault account.",
  13: "Invalid token program.",
  14: "Invalid engine configuration for this market.",
  15: "Math overflow in engine calculation - try a smaller size.",
  16: "Account provenance mismatch - wrong market or account passed.",
  17: "Position has an unsettled leg - crank the market and retry.",
  18: "Invalid position leg.",
  // LF1 (2026-07-08): EngineStale is the ~500-slot ACCRUE cliff, not a normal
  // "wait a moment" blip - live-devnet verification found SOL/JUP/TRUMP sitting
  // 273k-283k slots past it, permanently reverting every trade/close. Once
  // tripped it does not self-clear from a normal price push or crank; only a
  // maintainer re-seeding the market fixes it. See useEngineFreshness.ts and
  // TRANSIENT_CODES below (removed from it, along with 21).
  19: "Engine stalled - no crank has landed on this market recently enough to trade. This will not clear on its own; the market needs a fresh re-seed. Please report it.",
  20: "Counterparty (backing) state is stale - crank the market, then retry.",
  // LF1 (2026-07-08): EngineLockActive is the OTHER symptom of the same cliff
  // as EngineStale(19) above - once a market crosses it, every trade/close
  // reverts one of the two, permanently, until a maintainer re-seeds it. The
  // previous copy here ("Price refreshing - retry") and the previous BUG 16
  // comment (claiming this self-clears via the keeper's ~20s Refresh crank)
  // were both disproven by the same live-devnet verification - see
  // TRANSIENT_CODES below (removed from it).
  21: "Engine lock is stuck (a crank/recovery never completed) - this will not clear on its own. The market needs a fresh re-seed before trading/closing can resume.",
  22: "Crank made no progress - the market may need attention. Try again shortly.",
  23: "This market is in recovery mode and must be cranked before trading resumes.",
  24: "Engine counter overflow.",
  25: "Engine counter underflow.",
  26: "Oracle is invalid - no price available for this market.",
  27: "Oracle price is stale - a fresh price must be pushed before trading. Try again in a moment.",
  28: "Oracle confidence interval too wide - price too uncertain to trade right now.",
  29: "Invalid oracle account for this market.",
  30: "An LP vault already exists for this market.",
  31: "LP vault not found for this market.",
  32: "LP vault is paused.",
  33: "LP vault still has shares outstanding - cannot proceed.",
  34: "Amount must be greater than zero.",
  35: "Insufficient LP vault shares.",
  36: "LP vault redemption cooldown is still active - wait before redeeming.",
  37: "Trade would exceed the market's open-interest cap. Try a smaller size.",
  38: "No LP vault fees available to crank yet.",
  39: "LP vault share supply mismatch - please report this error.",
  40: "LP vault authority mismatch.",
  41: "Deposit too small - it would mint zero LP shares. Deposit a larger amount.",
  42: "Position-NFT registry not found for this market.",
  43: "This position can't be transferred as an NFT right now.",
  44: "Invalid NFT transfer - cannot transfer to yourself or a zero address.",
  45: "Invalid NFT mint authority.",
  46: "Position-NFT provenance mismatch.",
  47: "Insurance withdrawal cooldown is still active.",
  48: "Insurance withdrawal exceeds the allowed ceiling (deposits-only limit).",
  49: "Insufficient margin for this trade - deposit more collateral or reduce size/leverage.",
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
  2: "NFT PDA does not match expected derivation - frontend/program version mismatch.",
  3: "Slab account not owned by the Percolator program.",
  4: "Slab data too short - corrupted or unsupported market.",
  5: "User index out of range for this slab.",
  6: "Position has changed since NFT was minted (entry-price mismatch).",
  7: "Only the NFT holder can burn / settle this position.",
  8: "Funding settlement overflow.",
  9: "Invalid mint authority - expected program PDA.",
  10: "NFT program cannot parse this market's slab layout - the NFT program is out of date relative to the deployed main program. An on-chain NFT program upgrade is required.",
  11: "Cannot transfer - position is being liquidated.",
  12: "Funding must be settled before transfer.",
  13: "Transfer hook: unknown Percolator program.",
  14: "Position must be fully closed (size and collateral at zero) before burn.",
  15: "Transfer hook: extra-metas PDA does not match expected derivation.",
  16: "Transfer hook: source or destination token account invalid.",
  17: "Transfer hook was invoked directly, not via Token-2022 CPI.",
  18: "This account is an LP account and cannot be wrapped as an NFT - only trading accounts are eligible.",
  19: "Account id mismatch - slot was reallocated to a different account.",
  20: "Slab slot was closed and reassigned to a different owner after this NFT was minted - the NFT no longer represents that position.",
  // EC (2026-07-08): 21-27 were missing entirely, so an NFT-program error in
  // this range fell through to the generic ERROR_CODE_MAP lookup instead -
  // e.g. code 22 is percolator-nft's LegNotActive ("no active leg trades this
  // asset_index in the portfolio", typically a liquidated/force-closed
  // wrapped position - see H8), but ERROR_CODE_MAP[22] is percolator-prog's
  // unrelated EngineNonProgress ("crank made no progress"). A user burning or
  // transferring an NFT that hit LegNotActive was shown the wrong error.
  21: "Portfolio account is not owned by a known Percolator wrapper program - this NFT may be pointed at the wrong market.",
  22: "This position has no active leg on this market anymore - it's likely already closed, liquidated, or force-closed. Burning may still be possible to reclaim the NFT's rent.",
  23: "Portfolio account failed to decode - the NFT program is out of date relative to the deployed main program, or the account was corrupted.",
  24: "Transfer blocked - this position isn't freely transferable right now (a close, resolve, or stale-market gate is active).",
  25: "Market ID mismatch - the slab slot this NFT points to was reused by a newer position. This NFT no longer represents a valid position.",
  26: "This market's NFT registry isn't configured yet - minting a Position NFT isn't available for this market.",
  27: "This position spans multiple legs (cross-margin) and can't be wrapped as a single NFT - only single-position portfolios are eligible.",
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

/**
 * BUG 15: SPL Token / Token-2022 program ids. Custom(1) is ambiguous between
 * percolator-prog's PercolatorError::InvalidVersion and SPL Token's
 * InsufficientFunds (e.g. depositing more sim-USDC than the wallet holds, via
 * CPI from DepositCollateral). Same disambiguate-by-originating-program-id
 * pattern as isNftProgramError above - hardcoded here (not imported) for the
 * same reason NFT_PROGRAM_ID is: this module is a leaf that must stay free of
 * the (client-only) PublicKey wrapper so it doesn't drag @/lib/tx into hook
 * tests that mock it.
 */
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function isSplTokenProgramError(msg: string): boolean {
  return msg.includes(SPL_TOKEN_PROGRAM_ID) || msg.includes(TOKEN_2022_PROGRAM_ID);
}

const SPL_TOKEN_INSUFFICIENT_FUNDS_MESSAGE =
  "Insufficient balance - you're trying to deposit more than your wallet holds. " +
  "Reduce the amount or add more funds and try again.";

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
// v17 codes: EngineBStale=20, OracleInvalid=26, OracleStale=27.
// LF1 (2026-07-08): EngineStale=19 and EngineLockActive=21 used to be listed
// here too, on the theory (BUG 16) that 21 self-clears via the keeper's ~20s
// Refresh crank. Live-devnet verification disproved that: SOL/JUP/TRUMP sat
// 273k-283k slots past the ~500-slot accrue cliff, permanently reverting
// EngineStale(19)/EngineLockActive(21) on every trade/close - no amount of
// retrying clears them, only a market re-seed does. Removed both from this
// set (and 21 from LONG_WINDOW_RETRY below) so withTransientRetry stops
// silently retrying a dead market 8x before finally telling the user. See
// ERROR_CODE_MAP[19]/[21] and useEngineFreshness.ts for the corrected model.
const TRANSIENT_CODES = new Set([20, 26, 27]);

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
  // v17: OracleStale=27, OracleInvalid=26, EngineBStale=20 — all resolved by
  // pushing a fresh price / cranking the market. EngineStale=19 is
  // deliberately NOT included — see LF1 in TRANSIENT_CODES above: unlike
  // these three, 19 is the ~500-slot accrue cliff and does not self-clear
  // from a normal price push or crank once tripped; it needs a re-seed.
  return code === 27 || code === 26 || code === 20;
}

export function isEngineLockError(msg: string): boolean {
  const code = extractErrorCode(msg);
  return code === 21 || code === 19;
}


/**
 * @param context Optional call-site hint for disambiguating error codes that
 *   mean different things depending on which instruction produced them (see
 *   TX1 below). Omit for the generic case; pass "trade" from a trade()-CPI
 *   submit path (open or close).
 */
export function humanizeError(rawMsg: string, context?: "trade"): string {
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
    return "Invalid account data - one of the accounts has unexpected data. The transaction may need different accounts or the market state may have changed.";
  }
  if (rawMsg.includes('"AccountAlreadyInitialized"')) {
    return "Account already exists - this operation was already completed.";
  }
  if (rawMsg.includes('"AccountNotFound"') || rawMsg.includes("AccountNotFound")) {
    return "Account not found on-chain. It may have been closed or not yet created.";
  }
  if (rawMsg.includes("insufficient account keys")) {
    return "Missing accounts in transaction - this is likely a frontend bug. Please report it.";
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
    // BUG 15: Custom(1) from the SPL Token program (InsufficientFunds, e.g. a
    // deposit CPI where the user's ATA doesn't hold enough) must not be read as
    // percolator-prog's Custom(1)=InvalidVersion. Route by originating program
    // id before falling into the generic ERROR_CODE_MAP lookup below.
    if (code === 1 && !isNftProgramError(rawMsg) && isSplTokenProgramError(rawMsg)) {
      return SPL_TOKEN_INSUFFICIENT_FUNDS_MESSAGE;
    }
    // TX1 (2026-07-08): Custom(9) from a trade() CPI submit is the
    // slippage/worst-fill-price rejection (the fill moved past the
    // limitPriceE6 bound the ticket sent on-chain) — NOT the generic
    // "invalid/unsupported instruction" text in ERROR_CODE_MAP[9], which is
    // correct for deposit/withdraw/NFT/market-creation call sites (where
    // code 9 really does mean an instruction-selector/matcher mismatch).
    // Only trade-submit call sites pass context: "trade".
    if (code === 9 && context === "trade") {
      return "Price moved past your slippage tolerance before this order filled. Try again — the size and leverage are unchanged.";
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
    return "Transaction expired - network was slow. Try again, it usually works on the second attempt.";
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
    return "Token account not found on the RPC this page is connected to. The wallet may hold the NFT from a different network, or the RPC may be out of sync - try refreshing the page.";
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
    return "Transaction timed out. It may still confirm - check your wallet.";
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

// Lets a caller-recognized transient code widen withTransientRetry's own
// retry budget beyond what the call site requested (e.g. useClosePosition.ts
// passes a short maxRetries/delayMs sized for "retry a dropped RPC call";
// a genuinely longer-cadence transient condition needs more room than that).
//
// LF1 (2026-07-08) history: this used to carry `21: { maxRetries: 8,
// delayMs: 4000 }` on the theory (BUG 16) that EngineLockActive(21)
// self-clears via the keeper's ~20s Refresh crank. Live-devnet verification
// disproved that for the cliff-dead case (see TRANSIENT_CODES above) - 21
// was removed from TRANSIENT_CODES, so isTransientError() never reaches this
// map for it anymore. Left empty as an extension point for any future
// genuinely long-window transient code.
const LONG_WINDOW_RETRY: Record<number, { maxRetries: number; delayMs: number }> = {};

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 2, delayMs = 3000 }: { maxRetries?: number; delayMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  let effectiveMaxRetries = maxRetries;
  let effectiveDelayMs = delayMs;
  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < effectiveMaxRetries && isTransientError(msg)) {
        const code = extractErrorCode(msg);
        const longWindow = code !== null ? LONG_WINDOW_RETRY[code] : undefined;
        if (longWindow) {
          effectiveMaxRetries = Math.max(effectiveMaxRetries, longWindow.maxRetries);
          effectiveDelayMs = Math.max(effectiveDelayMs, longWindow.delayMs);
        }
        await new Promise((r) => setTimeout(r, effectiveDelayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}
