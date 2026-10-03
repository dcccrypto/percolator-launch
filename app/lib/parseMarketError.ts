/**
 * Parse Solana transaction errors into user-friendly messages for market creation.
 * Covers common failure modes: insufficient balance, user rejection, network errors,
 * and Percolator program-specific error codes.
 */

import { P3_ERR } from "@/lib/limits/constants";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { keepAppMessage, resolveUserMessage } from "@/lib/limits/user-message";
import { decodeError } from "@percolatorct/sdk";
import type { CreateStepKind } from "@/lib/create-market-v18";

/**
 * Where in the launch the failure happened. The same program error means
 * different things at different steps, so a context-free message is often
 * wrong (see STEP_ERROR_OVERRIDES).
 */
export interface MarketCreationErrorContext {
  step?: CreateStepKind;
  /** User-facing name of the step, e.g. "Funding liquidity". Prefixed to the message. */
  stepLabel?: string;
}

/**
 * EngineStale (19) during market CREATION. On the v18 wrapper, Custom 19 is
 * `V16Error::Stale`, which covers every CAS / replay-lane mismatch
 * (`require_authority_epoch_view`, `require_newer_control_sequence`, the
 * portfolio matcher-sequence) as well as engine accrual staleness. A market
 * created seconds ago cannot be accrual-stale — measured 2026-09-29, the
 * crank and every funding instruction simulate clean on a market 1.5 h after
 * creation with no keeper pushes — so during creation it means a counter this
 * step was built against had already moved. The old copy ("a crank is needed",
 * "may need a full re-seed") sent users to the wrong fix.
 */
const CREATE_ENGINE_STALE =
  "The program refused this step because a counter it was built against had already moved on-chain " +
  "(EngineStale — a stale authority epoch or sequence number, not a stale price or engine clock). " +
  "Nothing from this step was applied. Retry rebuilds it from the market's live on-chain state.";

import { EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE } from "@/lib/earn-vault-seed";

/** Per-step meanings that differ from the generic code table. */
const STEP_ERROR_OVERRIDES: Partial<Record<CreateStepKind, Record<number, string>>> = {
  "oracle-delegation": {
    [WRAPPER_ERR.Unauthorized]:
      "The price feed was already handed to the keeper in an earlier attempt, so your wallet is no longer " +
      "the oracle authority and re-sending the hand-off is refused (Unauthorized). This step is already " +
      "complete — Retry continues from the next step.",
  },
  funding: {
    [WRAPPER_ERR.InvalidInstruction]:
      "The program rejected the liquidity-backing seed's arguments (InvalidInstruction). This is an app bug, " +
      "not a problem with your wallet or funds — nothing from this step was applied.",
  },
  "earn-vault": {
    // LpVaultBackingBucketNotEmpty. Only reachable on a market whose backing was
    // seeded by the pre-fix launcher (direct top-up): retrying can never succeed.
    [WRAPPER_ERR.LpVaultBackingBucketNotEmpty]: EARN_VAULT_BUCKET_NOT_EMPTY_MESSAGE,
    // Wrapper 7a3ac04c+: the seed deposit (75) refused because a pot is over-impaired / the share
    // price collapsed. A brand-new vault cannot be in that state; kept so it never reads raw.
    [WRAPPER_ERR.LpVaultTargetPotImpaired]:
      "The Earn vault isn't taking deposits right now, so its starting deposit was refused. Nothing from this step was applied.",
  },
  // P3 InitVaultLp (94) + DepositJuniorTranche (96): codes from the one constants module.
  "vault-lp": {
    [P3_ERR.VaultLpAlreadyBound]:
      "This market's Earn vault already provides its liquidity (an earlier attempt completed this step). Retry continues from the next step.",
    [P3_ERR.VaultLpMultiAssetMarket]:
      "This market holds more than one asset, and the Earn vault can only provide liquidity to a single-asset market. Retrying this market won't help: start a new market (the wizard now creates single-asset markets).",
    [P3_ERR.VaultLpBindRequiresFlatAsset]:
      "This market already has open positions, so the Earn vault can't take over its liquidity: that step has to run when the market is created, before any trade. Retrying this market won't help: start a new market.",
    [WRAPPER_ERR.Unauthorized]:
      "Only the market's admin can connect the Earn vault, and admin rights have already moved to the staking pool, so this market can no longer be connected. It keeps its current liquidity.",
  },
  "stake-pool": {
    [WRAPPER_ERR.Unauthorized]:
      "Market admin authority has already moved to the staking pool (an earlier attempt completed this step), " +
      "so your wallet can no longer sign it (Unauthorized). The market is set up — reload to see it.",
  },
};

/** Custom program error code in `msg`, from either the hex log form or the InstructionError JSON form. */
export function extractCustomCode(msg: string): number | null {
  const hex = msg.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const ie = msg.match(/"?InstructionError"?.*?"?Custom"?\D*(\d+)/);
  if (ie) return parseInt(ie[1], 10);
  return null;
}

// v17 error codes are sourced from the SDK (PERCOLATOR_ERRORS in @percolatorct/sdk).
// The SDK exports decodeError(code) → { name, hint } | undefined for codes 0-46.
// This local map is kept for error codes that need launch-specific user messages
// (e.g. code 5 — InvalidAccountLen — gets a slab-tier-specific message).
// All other codes fall through to decodeError() for the SDK hint.
const LAUNCH_ERROR_OVERRIDES: Record<number, string> = {
  // 91: LpVaultTargetPotImpaired (wrapper 7a3ac04c+; SDK 8.0.0 does not know it yet)
  [WRAPPER_ERR.LpVaultTargetPotImpaired]: "Earn deposits are paused while this vault settles. Nothing was sent.",
  // 0: InvalidMagic
  [WRAPPER_ERR.InvalidMagic]: "Invalid magic number. The market account data is corrupted. Check the market address.",
  // 1: InvalidVersion
  [WRAPPER_ERR.InvalidVersion]: "Account version mismatch (expected v17). The program may need upgrading or the market was created with an older program.",
  // 2: AlreadyInitialized
  [WRAPPER_ERR.AlreadyInitialized]: "Market is already initialized. Cannot re-initialize.",
  // 3: NotInitialized
  [WRAPPER_ERR.NotInitialized]: "Market is not initialized. The slab account may not have been set up correctly.",
  // 4: InvalidAccountKind
  [WRAPPER_ERR.InvalidAccountKind]: "Wrong account kind. A market group, portfolio, or insurance-ledger address was used in the wrong position.",
  // 5: InvalidAccountLen — include slab-tier guidance
  [WRAPPER_ERR.InvalidAccountLen]: "Invalid account length. This market uses an incompatible account size — it may have been created with an older program version. " +
     "The market may need re-initialization by the market creator, or try a different slab tier.",
  // 8: Unauthorized
  [WRAPPER_ERR.Unauthorized]: "Not authorized for this operation. Ensure the correct authority wallet (marketauth or asset_admin) is connected.",
  // 15: EngineArithmeticOverflow
  [WRAPPER_ERR.EngineArithmeticOverflow]: "Math overflow — values are too large for safe computation. Try a smaller amount or position size.",
  // 16: EngineProvenanceMismatch
  [WRAPPER_ERR.EngineProvenanceMismatch]: "Portfolio provenance mismatch. This portfolio was not created for this market group.",
  // 18: EngineInvalidLeg
  [WRAPPER_ERR.EngineInvalidLeg]: "Invalid trade leg. Check asset_index and size parameters.",
  // 19: EngineStale. LF1 (2026-07-08): this used to promise a bare retry
  // would fix it ("a permissionless crank was prepended... retry"), which is
  // true for a brand-new market awaiting its first crank but NOT for the
  // ~500-slot accrue cliff a market can also hit — live-devnet verification
  // found markets sitting hundreds of thousands of slots past it, where
  // EngineStale is permanent until a maintainer re-seeds the market. Hedge
  // the copy instead of promising a fix a retry can't deliver.
  [WRAPPER_ERR.EngineStale]: "Market engine is stale — a crank is needed before this step can proceed. If this keeps happening after a retry or two, the crank isn't clearing it and the market's engine may need a full re-seed rather than a simple crank — contact a maintainer.",
  // 21: EngineLockActive. Same LF1 fix — the SDK's default hint ("wait for
  // it to complete") over-promises self-resolution the same way 19's old
  // copy did.
  [WRAPPER_ERR.EngineLockActive]: "Engine lock is active on this market (a close or recovery hasn't finished). If this doesn't clear after a retry or two, the market may need a full re-seed rather than simply waiting — contact a maintainer.",
};

const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Anchored parse of the FIRST failing program-error log line in `msg`
 * (innermost failure — outer programs re-log the same failure afterwards).
 * Returns the exact hex code and the failing program's identity: the id named
 * on the failing line itself ("Program <id> failed: custom program error:…"),
 * or, when the failing line doesn't name one, the innermost still-open
 * "Program <id> invoke" tracked via an invoke/success stack.
 *
 * This replaces the old substring heuristic
 * `includes("custom program error: 0x1") && includes("TokenkegQ")`, which
 * (a) prefix-matched 0x1 against 0x13/0x1a/…, and (b) attributed the failure
 * to the token program if a Tokenkeg line appeared ANYWHERE in the logs —
 * including a successful token CPI preceding an unrelated engine failure.
 */
function findFailingProgramError(msg: string): { code: number; program: string | null } | null {
  const invokeStack: string[] = [];
  for (const raw of msg.split(/\r?\n/)) {
    // Tolerate lines embedded as JSON array elements (leading/trailing quotes).
    const line = raw.trim().replace(/^"/, "").replace(/",?$/, "");
    const failMatch = line.match(/failed: custom program error: (0x[0-9a-fA-F]+)/);
    if (failMatch) {
      const idMatch = line.match(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed:/);
      return {
        code: parseInt(failMatch[1], 16),
        program: idMatch ? idMatch[1] : invokeStack[invokeStack.length - 1] ?? null,
      };
    }
    const invokeMatch = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke/);
    if (invokeMatch) {
      invokeStack.push(invokeMatch[1]);
      continue;
    }
    if (/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) success/.test(line)) {
      invokeStack.pop();
    }
  }
  return null;
}

/**
 * SPL Token "insufficient funds" is custom error 1 (0x1) thrown BY the token
 * program. Route to the token-balance message only when the failing line's
 * code is exactly 0x1 AND its program context is Tokenkeg.
 */
function isTokenProgramInsufficientFunds(msg: string): boolean {
  const failing = findFailingProgramError(msg);
  return failing !== null && failing.code === 0x1 && failing.program === SPL_TOKEN_PROGRAM_ID;
}

export function parseMarketCreationError(error: unknown, context?: MarketCreationErrorContext): string {
  const base = parseMarketCreationErrorBase(error, context);
  return context?.stepLabel ? `${context.stepLabel} failed: ${base}` : base;
}

function parseMarketCreationErrorBase(error: unknown, context?: MarketCreationErrorContext): string {
  const msg = error instanceof Error ? error.message : String(error);

  // Step-aware program errors first: with a step known, a Custom code has a
  // specific meaning that the generic table below gets wrong.
  if (context?.step) {
    const code = extractCustomCode(msg);
    if (code !== null && !isTokenProgramInsufficientFunds(msg)) {
      const stepOverride = STEP_ERROR_OVERRIDES[context.step]?.[code];
      if (stepOverride) return stepOverride;
      if (code === WRAPPER_ERR.EngineStale) return CREATE_ENGINE_STALE;
    }
  }

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
    isTokenProgramInsufficientFunds(msg)
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
      return resolveUserMessage(error, { surface: "create" }).body;
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

  // Bare RPC/wallet-transport failure ("Internal error" — JSON-RPC -32603, or an
  // equally opaque wallet-side send failure with no program logs attached). This
  // carries no custom-error code and no InstructionError, so none of the checks
  // above can classify it — it's a transport/node hiccup, not an on-chain
  // rejection. Give the user an actionable, honest message instead of echoing
  // the bare string (tester-reported as "Transaction failed: Internal error"
  // on the Earn-vault step).
  if (/^internal error$/i.test(msg.trim()) || msg.includes("-32603")) {
    return "The RPC node returned a generic internal error (no on-chain detail) — usually a transient node hiccup on a load-balanced devnet endpoint. Click Retry; if it keeps happening on the same step, try again in a minute or add your own Helius devnet key.";
  }

  // Fallback: truncate long messages but keep them informative
  // UX WP-1: raw chain text never reaches the user; the resolver keeps it in Details.
  if (msg.length > 200) {
    return resolveUserMessage(error, { surface: "create" }).body;
  }

  return keepAppMessage(msg) === msg ? msg : resolveUserMessage(error, { surface: "create" }).body;
}
