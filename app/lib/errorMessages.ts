import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { P2_ERROR_COPY } from "@/lib/limits/copy";
import { PORTFOLIO_LOOKUP_COPY } from "@/lib/owner-portfolio";
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
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { V21_ERROR_CODE_MAP } from "@/lib/v21/error-copy";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { V22_ERROR_CODE_MAP, V22_STAKE_ERROR_CODE_MAP } from "@/lib/v22/error-copy";
import { V22_ENGINE_LOCK_CODES } from "@/lib/v22/wrapper-errors";
import { stakeProgramIdOrNull } from "@/lib/v22/program-ids";
import { V21_ENGINE_LOCK_CODES } from "@/lib/v21/wrapper-errors";
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
/**
 * P1 wrapper errors (Custom 66..71, feat/p1-safety-release). The single
 * source of P1 wording: lib/limits/errors.ts reuses this table.
 */
export const P1_ERROR_MESSAGES: Record<number, string> = {
  // p1-safety-release-2026-09-29.md §3 (append-only; feat/p1-safety-release). Harmless before
  // the P1 deploy: the deployed wrapper never returns these codes.
  [WRAPPER_ERR.ExecPriceOutsideOracleBand]: "The price moved too far for this trade, so it didn't go through. Try again; if it keeps happening the price is moving fast.",
  [WRAPPER_ERR.SameOwnerTrade]: "This wallet owns this market's liquidity or created the market, so it can only close positions here, not open or add to them. Use a different wallet to trade.",
  [WRAPPER_ERR.LpExposureCapExceeded]: "This trade is larger than the market has room for right now. Try a smaller size.",
  [WRAPPER_ERR.LpFloorHalt]: "The market has no room for new positions right now, so opening is paused. Closing positions still works.",
  [WRAPPER_ERR.ProtocolSideOiCapExceeded]: "This side of the market has reached its open-interest cap. Try a smaller size or the other side.",
  [WRAPPER_ERR.CloseSlabFeesOutstanding]: "The market's last fees are being collected. Close again in a minute.",
};

const ERROR_CODE_MAP: Record<number, string> = {
  [WRAPPER_ERR.InvalidMagic]: "Invalid market data (bad magic) - corrupted or not a Percolator market.",
  [WRAPPER_ERR.InvalidVersion]: "This market uses a different program version and needs migration.",
  [WRAPPER_ERR.AlreadyInitialized]: "Market already initialized.",
  [WRAPPER_ERR.NotInitialized]: "Market not initialized.",
  [WRAPPER_ERR.InvalidAccountKind]: "Wrong account type for this action.",
  [WRAPPER_ERR.InvalidAccountLen]: "Invalid account data length - corrupted account.",
  [WRAPPER_ERR.ExpectedSigner]: "Missing required signature.",
  [WRAPPER_ERR.ExpectedWritable]: "An account that must be writable was passed as read-only.",
  // Custom(8) = PercolatorError::Unauthorized from the PROGRAM: the connected
  // wallet is not the authority the instruction requires. Not the same thing as
  // a wallet that is locked / has not authorised this site (Phantom 4100,
  // Solflare "wallet is locked") — those are detected in detectWalletError and
  // never reach this map.
  [WRAPPER_ERR.Unauthorized]: "Not authorized: the connected wallet isn't the account this action requires (for example the market's creator or admin, or the owner of this position). If you switched wallets, reconnect the one you used for this market.",
  [WRAPPER_ERR.InvalidInstruction]: "Invalid or unsupported instruction. (If this is a market order, the market's matcher config may be misaligned on-chain. Please report this to the team.)",
  [WRAPPER_ERR.InvalidMint]: "Invalid mint account.",
  [WRAPPER_ERR.InvalidTokenAccount]: "Invalid token account.",
  [WRAPPER_ERR.InvalidVaultAccount]: "Invalid vault account.",
  [WRAPPER_ERR.InvalidTokenProgram]: "Invalid token program.",
  [WRAPPER_ERR.EngineInvalidConfig]: "Invalid engine configuration for this market.",
  [WRAPPER_ERR.EngineArithmeticOverflow]: "Math overflow in engine calculation - try a smaller size.",
  [WRAPPER_ERR.EngineProvenanceMismatch]: "Account provenance mismatch - wrong market or account passed.",
  [WRAPPER_ERR.EngineHiddenLeg]: "Position has an unsettled leg - crank the market and retry.",
  [WRAPPER_ERR.EngineInvalidLeg]: "Invalid position leg.",
  // LF1 (2026-07-08): EngineStale is the ~500-slot ACCRUE cliff, not a normal
  // "wait a moment" blip - live-devnet verification found SOL/JUP/TRUMP sitting
  // 273k-283k slots past it, permanently reverting every trade/close. Once
  // tripped it does not self-clear from a normal price push or crank; only a
  // maintainer re-seeding the market fixes it. See useEngineFreshness.ts and
  // TRANSIENT_CODES below (removed from it, along with 21).
  // Custom(19) = V16Error::Stale. It has THREE distinct causes (verified against
  // the deployed engine 2026-07-27), so the copy must not assert only one:
  //   1. Withdraw with an open position — withdraw_not_atomic (v16.rs:14412)
  //      returns Stale whenever active_bitmap is non-empty, BY DESIGN. Close first.
  //      (useWithdraw overrides this with a position-specific message.)
  //   2. A favorable action (e.g. claim released PnL) on an account whose health
  //      cert has drifted behind the header epoch — clears with a crank.
  //   3. A genuinely deep-stale market — needs a maintainer crank/re-seed.
  [WRAPPER_ERR.EngineStale]: "This action can't be completed right now. If you're withdrawing, close your open position first — collateral backing a position can't be withdrawn. Otherwise the market may just need a moment; try again shortly, and report it if it persists.",
  [WRAPPER_ERR.EngineBStale]: "Counterparty (backing) state is stale - crank the market, then retry.",
  // LF1 (2026-07-08): EngineLockActive is the OTHER symptom of the same cliff
  // as EngineStale(19) above - once a market crosses it, every trade/close
  // reverts one of the two, permanently, until a maintainer re-seeds it. The
  // previous copy here ("Price refreshing - retry") and the previous BUG 16
  // comment (claiming this self-clears via the keeper's ~20s Refresh crank)
  // were both disproven by the same live-devnet verification - see
  // TRANSIENT_CODES below (removed from it).
  // Custom(21) = V16Error::LockActive. Causes (verified 2026-07-27): the market
  // is not Live / in recovery; an account has a close-in-progress ledger; the
  // market's LP counterparty went bankrupt (bankruptcy_hlock, needs the losing
  // position settled); or a genuinely deep-stale market. It does NOT always mean
  // "re-seed" — a transient lag clears on its own; a bankrupt/recovery market
  // needs maintainer action. Don't promise either outcome.
  [WRAPPER_ERR.EngineLockActive]: "This market is temporarily locked, or reduce-only while it recovers from a bankruptcy. Closing positions still works (your close is sent as a unilateral exit if needed); new positions may be paused until the market reopens on its own. If a brief lag, try again in a moment.",
  [WRAPPER_ERR.EngineNonProgress]: "Crank made no progress - the market may need attention. Try again shortly.",
  [WRAPPER_ERR.EngineRecoveryRequired]: "This market is in recovery mode and must be cranked before trading resumes.",
  [WRAPPER_ERR.EngineCounterOverflow]: "Engine counter overflow.",
  [WRAPPER_ERR.EngineCounterUnderflow]: "Engine counter underflow.",
  [WRAPPER_ERR.OracleInvalid]: "Oracle is invalid - no price available for this market.",
  [WRAPPER_ERR.OracleStale]: "Oracle price is stale - a fresh price must be pushed before trading. Try again in a moment.",
  [WRAPPER_ERR.OracleConfTooWide]: "Oracle confidence interval too wide - price too uncertain to trade right now.",
  [WRAPPER_ERR.InvalidOracleKey]: "Invalid oracle account for this market.",
  [WRAPPER_ERR.LpVaultAlreadyExists]: "An LP vault already exists for this market.",
  [WRAPPER_ERR.LpVaultNotFound]: "LP vault not found for this market.",
  [WRAPPER_ERR.LpVaultPaused]: "LP vault is paused.",
  [WRAPPER_ERR.LpVaultSharesOutstanding]: "LP vault still has shares outstanding - cannot proceed.",
  [WRAPPER_ERR.LpVaultZeroAmount]: "Amount must be greater than zero.",
  [WRAPPER_ERR.LpVaultInsufficientShares]: "Insufficient LP vault shares.",
  [WRAPPER_ERR.LpVaultCooldownActive]: "LP vault redemption cooldown is still active - wait before redeeming.",
  [WRAPPER_ERR.LpVaultOiReservationViolated]: "Trade would exceed the market's open-interest cap. Try a smaller size.",
  [WRAPPER_ERR.LpVaultNoFeesToCrank]: "No LP vault fees available to crank yet.",
  [WRAPPER_ERR.LpVaultSupplyMismatch]: "LP vault share supply mismatch - please report this error.",
  [WRAPPER_ERR.LpVaultAuthorityMismatch]: "LP vault authority mismatch.",
  [WRAPPER_ERR.LpVaultZeroSharesMinted]: "Deposit too small - it would mint zero LP shares. Deposit a larger amount.",
  [WRAPPER_ERR.NftRegistryNotFound]: "Position-NFT registry not found for this market.",
  [WRAPPER_ERR.NftPortfolioNotTransferable]: "This position can't be transferred as an NFT right now.",
  [WRAPPER_ERR.NftTransferSelfOrZero]: "Invalid NFT transfer - cannot transfer to yourself or a zero address.",
  [WRAPPER_ERR.NftInvalidMintAuthority]: "Invalid NFT mint authority.",
  [WRAPPER_ERR.NftPortfolioProvenance]: "Position-NFT provenance mismatch.",
  [WRAPPER_ERR.InsuranceWithdrawCooldownActive]: "Insurance withdrawal cooldown is still active.",
  [WRAPPER_ERR.InsuranceWithdrawCeilingExceeded]: "Insurance withdrawal exceeds the allowed ceiling (deposits-only limit).",
  [WRAPPER_ERR.EngineInsufficientInitialMargin]: "Insufficient margin for this trade - deposit more collateral or reduce size/leverage.",
  // ── v17 fee-split + stake/keeper ordinals (50-61) ────────────────────────
  // Source: SDK abi/errors.ts (v16_program.rs PercolatorError, percolator-prog@10acb5ae,
  // deployed to the fresh wrapper DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj). These
  // were missing entirely from this map — 51/52 in particular are the fee-split floors/sum
  // errors the launch wizard's UpdateFeeSplit (tag 86) can trip if a bad split reaches chain.
  [WRAPPER_ERR.LpVaultDepositBelowMinimumLiquidity]: "First LP vault deposit is below the minimum-liquidity floor. Deposit a larger amount.",
  [WRAPPER_ERR.FeeSplitFloorViolation]: "Fee split violates the on-chain floors (creator ≤ 3600 bps, LP ≥ 3200 bps, insurance ≥ 1200 bps of the post-protocol remainder). Adjust the shares in the launch wizard.",
  [WRAPPER_ERR.FeeSplitSumInvalid]: "Fee split shares must sum to exactly 8000 bps (the 80% left after the fixed 20% protocol cut). Adjust the shares in the launch wizard.",
  [WRAPPER_ERR.NoInsuranceReserveToClaim]: "Nothing to claim from the insurance reserve yet — it's already fully pushed. Retry after more trading volume.",
  [WRAPPER_ERR.StakePoolNotBound]: "No stake pool bound to this market — BindInsuranceAuthority hasn't run, so the staker/insurance leg has no exit.",
  [WRAPPER_ERR.StakePoolOwnerMismatch]: "The supplied stake pool is not owned by the canonical stake program (forgery gate).",
  [WRAPPER_ERR.StakePoolAuthorityMismatch]: "Stake pool authority mismatch — this pool did not bind itself to this market.",
  [WRAPPER_ERR.StakePoolMarketMismatch]: "Stake pool belongs to a different market.",
  [WRAPPER_ERR.StakePoolWrapperMismatch]: "Stake pool was initialized against a different wrapper program.",
  [WRAPPER_ERR.StakePoolModeMismatch]: "Stake pool is not in insurance-LP mode, so it is not owed the insurance/staker fee leg.",
  [WRAPPER_ERR.StakeProgramNotPinned]: "This wrapper build has no pinned stake program — the insurance-reserve-to-stake withdrawal has no trusted destination (expected off devnet).",
  [WRAPPER_ERR.AssetSlotAlreadyConfigured]: "This asset slot is already configured/active — only an append at the next index or a re-activation of a retired slot is allowed.",
  // 62-65: on the DEPLOYED wrapper (deploy/v18.2-wrapper@6377376a PercolatorError), missing here until P0b.
  [WRAPPER_ERR.CreatorFeeOverClaim]: "That's more than the creator fees available to claim right now. Claim the amount shown, or wait for more trading.",
  [WRAPPER_ERR.LpVaultBackingBucketNotEmpty]: "This market's backing is already funded outside the Earn vault, so an Earn vault can't be created for it.",
  [WRAPPER_ERR.RentExemptRequired]: "The market account must stay rent-exempt after this action. Please report this — it should not happen on a normal market.",
  [WRAPPER_ERR.AssetGenerationMismatch]: "This market's asset changed since the transaction was built. Refresh the page and try again.",
  // ── P1 safety release (oracle band, auto-halt, exposure cap) ──────────────
  // Codes are appended after 61 by feat/p1-safety-release; add one line per
  // code here from ~/percolator-ops/ledger/p1-safety-release-2026-09-29.md.
  // market-error.ts (explainMarketTxError) can refine any of them with live
  // market health, the same way 19/21/49 are refined.
  ...P1_ERROR_MESSAGES,
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
const NFT_PROGRAM_ID = resolveDevnetProgramIds().nft;

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

// ── Wallet-side errors (Phantom / Solflare / Privy) ─────────────────────────
// A wallet that is LOCKED or has not authorised this site is not a program
// "Unauthorized". Shapes observed/documented:
//   Phantom  : {code: 4100, message: "The requested method and/or account has not been authorized by the user."}
//              {code: 4001, message: "User rejected the request."}
//   Solflare : "Wallet is locked" / "WalletNotConnectedError" / "User rejected the request"
//   adapters : WalletNotConnectedError, WalletSignTransactionError: "Wallet not connected"
export const WALLET_LOCKED_MESSAGE =
  "Your wallet is locked or hasn't authorised this site. Unlock Phantom / Solflare, reconnect it from the header, and try again. Nothing was sent.";
export type WalletErrorKind = "locked" | "rejected";

export function detectWalletError(msg: string): WalletErrorKind | null {
  if (/has not been authori[sz]ed by the user|\b4100\b.*authori[sz]|wallet is locked|locked wallet|WalletNotConnected|wallet not connected|please unlock/i.test(msg)) {
    return "locked";
  }
  if (/user rejected|rejected the request|user declined|transaction rejected|request rejected|\b4001\b/i.test(msg)) {
    return "rejected";
  }
  return null;
}

/**
 * Program id of the FIRST "Program <id> failed: custom program error" log line
 * — the innermost failing program (a CPI failure is logged by the callee
 * first, then re-logged by each caller). Null when no such line is present.
 */
export function failingProgramId(msg: string): string | null {
  const m = msg.match(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: custom program error/);
  return m ? m[1] : null;
}

const MATCHER_PROGRAM_ID = resolveDevnetProgramIds().matcher;
const WRAPPER_PROGRAM_ID = resolveDevnetProgramIds().wrapper;

export function extractErrorCode(msg: string): number | null {
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
const TRANSIENT_CODES = new Set<number>([WRAPPER_ERR.EngineBStale, WRAPPER_ERR.OracleInvalid, WRAPPER_ERR.OracleStale]);

export function isTransientError(msg: string): boolean {
  // A confirmation timeout must NEVER classify as transient: the tx may have
  // already landed, and withTransientRetry callers (OrderTicket handleTrade,
  // useClosePosition) REBUILD AND RESEND the transaction — retrying a landed
  // trade double-fills. pollConfirmation's message also embeds a base58
  // signature whose digit runs ("429") used to false-positive the old
  // substring rate-limit check. Guard first, before any other match.
  if (/confirmation timeout|may still land/i.test(msg)) return false;
  const code = extractErrorCode(msg);
  if (code !== null && TRANSIENT_CODES.has(code)) return true;
  if (msg.includes("Blockhash not found")) return true;
  if (msg.includes("block height exceeded")) return true;
  if (msg.includes("has expired")) return true;
  // HTTP 429 rate limit → safe to retry (the tx was never accepted). A bare
  // "429" substring is NOT enough — base58 signatures and arbitrary numbers
  // can contain it — so require explicit rate-limit phrasing, optionally
  // alongside a word-bounded 429 status code.
  if (/too many requests/i.test(msg)) return true;
  if (/\b429\b/.test(msg) && /rate.?limit/i.test(msg)) return true;
  return false;
}

export function isOracleStaleError(msg: string): boolean {
  const code = extractErrorCode(msg);
  // v17: OracleStale=27, OracleInvalid=26, EngineBStale=20 — all resolved by
  // pushing a fresh price / cranking the market. EngineStale=19 is
  // deliberately NOT included — see LF1 in TRANSIENT_CODES above: unlike
  // these three, 19 is the ~500-slot accrue cliff and does not self-clear
  // from a normal price push or crank once tripped; it needs a re-seed.
  return code === WRAPPER_ERR.OracleStale || code === WRAPPER_ERR.OracleInvalid || code === WRAPPER_ERR.EngineBStale;
}

export function isEngineLockError(msg: string): boolean {
  const code = extractErrorCode(msg);
  return (
    code === WRAPPER_ERR.EngineLockActive ||
    code === WRAPPER_ERR.EngineStale ||
    // Devnet v2.2: 118 (exit needs loss-current) is an engine lock the app retries through.
    (code !== null && isDevnetV22Enabled() && V22_ENGINE_LOCK_CODES.includes(code)) ||
    // Devnet v2.1, P2b E7: the codes that split out of 21 (close-only after ADL, refreshing, Earn
    // backed gate). Flag-gated: the live wrapper never raises them.
    (code !== null && isDevnetV21Enabled() && V21_ENGINE_LOCK_CODES.includes(code))
  );
}


/**
 * @param context Optional call-site hint for disambiguating error codes that
 *   mean different things depending on which instruction produced them (see
 *   TX1 below). Omit for the generic case; pass "trade" from a trade()-CPI
 *   submit path (open or close).
 */
/** Shown when the wallet has no SOL to pay network fees (top-level AccountNotFound). */
export const NO_SOL_FOR_FEES_MESSAGE =
  "Your wallet needs a little devnet SOL to pay network fees. Use Get test funds (the faucet) to add some, then try again.";

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

  // Wallet-side refusals BEFORE any code extraction: a locked Phantom/Solflare
  // must never read as the program's Custom(8) "Not authorized".
  // lib/maintenance.ts MaintenanceError: already user-facing.
  if (rawMsg.includes("The playground is in maintenance")) {
    return rawMsg.slice(rawMsg.indexOf("The playground is in maintenance"));
  }
  // M-4: lib/owner-portfolio.ts PortfolioLookupError — already calm, user-facing copy.
  if (rawMsg.includes(PORTFOLIO_LOOKUP_COPY)) return PORTFOLIO_LOOKUP_COPY;
  const walletErr = detectWalletError(rawMsg);
  if (walletErr === "locked") return WALLET_LOCKED_MESSAGE;
  if (walletErr === "rejected") return "Transaction cancelled.";

  // Handle Solana system errors BEFORE custom code extraction.
  // These are string-form errors like "InvalidAccountData", "AccountAlreadyInitialized" etc.
  // They must NOT be confused with Percolator custom program error codes.
  if (rawMsg.includes('"InvalidAccountData"')) {
    // On the TRADE path this is almost never an account problem. The wrapper's
    // validate_matcher_return maps EVERY matcher-return rejection to
    // ProgramError::InvalidAccountData, and the common trigger by far is an
    // order larger than the matcher's per-trade cap (maxFillAbs): the matcher
    // clamps the fill but does not set FLAG_PARTIAL_OK, so the wrapper refuses
    // the under-fill. Verified on devnet 2026-07-29 — a trade of exactly
    // maxFillAbs succeeded and maxFillAbs+1 failed with this error, while every
    // wrong-account permutation produced a DIFFERENT error (Custom(8),
    // Custom(9), InvalidArgument, IncorrectProgramId). The old text sent people
    // to check their wallet and accounts, which are fine. See lib/matcherCaps.
    if (context === "trade") {
      return (
        "This trade is larger than the market can fill in one go. " +
        "Each market caps the size of a single trade to protect its liquidity provider, " +
        "and orders above that cap are rejected outright rather than partially filled. " +
        "Try a smaller size, or open the position in several trades."
      );
    }
    return "Invalid account data - one of the accounts has unexpected data. The transaction may need different accounts or the market state may have changed.";
  }
  if (rawMsg.includes('"AccountAlreadyInitialized"')) {
    return "Account already exists - this operation was already completed.";
  }
  if (rawMsg.includes('"AccountNotFound"') || rawMsg.includes("AccountNotFound")) {
    // A TOP-LEVEL AccountNotFound (not inside an InstructionError) is the runtime refusing a fee
    // payer with no SOL — the wallet has never been funded, so it "doesn't exist" (2026-10-02 live:
    // the faucet gave Sim-USDC but no SOL and every first trade showed "Account not found").
    if (!rawMsg.includes("InstructionError") && !/custom program error/i.test(rawMsg)) {
      return NO_SOL_FOR_FEES_MESSAGE;
    }
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
    // Code-overlap guard: the matcher's own custom codes are not wrapper codes.
    const origin = failingProgramId(rawMsg);
    if (origin && origin === MATCHER_PROGRAM_ID && origin !== WRAPPER_PROGRAM_ID) {
      // P2 matcher v2 codes (8002..8005) have plain copy; anything else keeps the generic line.
      if (P2_ERROR_COPY[code]) return P2_ERROR_COPY[code];
      return `The market's matcher rejected this fill (matcher error ${code}). Try a smaller size, or retry in a moment.`;
    }
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
    // Custom(9) === PercolatorError::InvalidInstruction on the deployed v18
    // wrapper. From a trade() CPI submit it has TWO causes and we cannot tell
    // them apart from the code alone:
    //   (a) the fill moved past the per-leg limitPrice bound (a genuine slippage
    //       rejection), OR
    //   (b) the trade instruction itself was invalid — e.g. feeBps=0 with a
    //       non-zero insurance share (the 2026-09 bug where the ticket assumed
    //       "feeBps=0 → market default" and every trade reverted here).
    // The old text asserted (a) only, which sent debugging down the slippage
    // path while the real cause was (b). Keep it honest: name the likely cause
    // and the recovery. Only trade-submit call sites pass context: "trade".
    if (code === WRAPPER_ERR.InvalidInstruction && context === "trade") {
      return "The trade was rejected by the program (invalid instruction) — usually the price moved past your slippage tolerance, or a trade parameter was off. Try again with the same size and leverage.";
    }
    // error-codes-4b1a5d30.md: a Custom(n) is the WRAPPER's code only when the wrapper raised
    // it. An unattributed code (no "Program X failed" line) or another program's is not guessed.
    if (origin === WRAPPER_PROGRAM_ID && ERROR_CODE_MAP[code]) {
      return ERROR_CODE_MAP[code];
    }
    // Devnet v2.2 (flag-gated): wrapper 104..119 / 123 / 124, stake v5 33..45. Checked before v2.1 / the legacy
    // table because the stake program reuses low numbers (33..45) that the wrapper table also owns.
    if (isDevnetV22Enabled()) {
      if (origin !== null && origin === stakeProgramIdOrNull() && V22_STAKE_ERROR_CODE_MAP[code]) return V22_STAKE_ERROR_CODE_MAP[code];
      if (origin === WRAPPER_PROGRAM_ID && V22_ERROR_CODE_MAP[code]) return V22_ERROR_CODE_MAP[code];
    }
    // Devnet v2.1 (flag-gated): growth-v19 92..99, P2b Earn 100..103, P2b lock exits 120..122.
    if (origin === WRAPPER_PROGRAM_ID && isDevnetV21Enabled() && V21_ERROR_CODE_MAP[code]) {
      return V21_ERROR_CODE_MAP[code];
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
    return "Mint account is not a valid SPL Token / Token-2022 mint. Refresh, then check the position's ⋯ menu still offers Unwrap.";
  }
  if (rawMsg.includes("TokenTransferHookAccountNotFound")) {
    return "Transfer-hook metadata account missing. This NFT was minted before a recent hook-fix upgrade; open a support ticket so we can run RepairExtraAccountMetas on it.";
  }
  if (rawMsg.includes("timeout") || rawMsg.includes("Timeout")) {
    return CONFIRMING_MESSAGE;
  }
  // UX WP-10 (audit §5.1 / §5.3 "unmapped"): never a raw code or "Transaction failed: …raw" in
  // the UI; the raw text stays in the console / the Details disclosure.
  console.warn("[humanizeError] unmapped:", rawMsg.slice(0, 300));
  // Never hide a cause the app can name (§5.3): an unknown on-chain code is named (no raw logs or
  // program ids). Free text is NOT passed through: runtime / RPC / wallet text is not ours to show.
  if (code !== null) return `Solana didn't accept this (error ${code}), so nothing changed.`;
  return UNMAPPED_MESSAGE;
}


/** §5.3 "unmapped": the one line for anything the maps do not know. */
export const UNMAPPED_MESSAGE = "Something went wrong and nothing was sent.";

/**
 * An error whose message was written for the user: plain, actionable, no raw codes. Hooks throw
 * it for their own explanations (an open position blocks a withdrawal, the market can only absorb
 * N% of a close); `userFacingMessage` passes it through where humanizeError would show the
 * unmapped line. Runtime / RPC / wallet text is never one of these, so it stays unmapped (18f85ba9).
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** The message of a UserFacingError, else null (the caller then humanizes as before). */
export function userFacingMessage(e: unknown): string | null {
  return e instanceof UserFacingError ? e.message : null;
}
/** §5.3 "confirmation timeout" (never "check your wallet"). */
export const CONFIRMING_MESSAGE = "Still confirming. We'll update this when it lands.";

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
