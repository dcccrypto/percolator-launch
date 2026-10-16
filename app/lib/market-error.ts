/**
 * Health-aware refinement of a failed market transaction's message.
 *
 * `humanizeError` (errorMessages.ts) maps a code to text without knowing the
 * market. Custom(19)/(21)/(49) each have several on-chain causes, and the
 * right message depends on the market's live state:
 *   - 21 on an open with the matcher LP at 0 capital → "LP depleted", not
 *     "market locked" (live 2026-09-29: COLLECT/TEXTIT/Murphy; after the
 *     self-heal repairs the remaining revert is Custom(49) at the trade);
 *   - 21 on a Resolved market → "resolved: close/withdraw only";
 *   - the bankruptcy h-lock is NEVER blamed for a trader Custom(21): it gates only LP-backing /
 *     insurance withdrawals, so a 21 on a trader path has another cause (ADL, LP depleted, …);
 *   - 19/21 with a lapsed bucket / ResetPending side → "retry: the repair is
 *     included" (self-heal normally prevents this; it can race the keeper);
 *   - 49 on an open with LP capital 0 → "LP depleted", not "deposit more".
 * Program Custom(8) is a genuine authority failure and is never refined into
 * "locked"; wallet-side lock/rejection is handled first by humanizeError.
 *
 * P1 (band / auto-halt / exposure cap) codes plug in through `refineP1`.
 */
import { detectWalletError, extractErrorCode, failingProgramId } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import type { LockReason, MarketHealthRow } from "@/lib/market-health";
import { p3LimitsErrorCopy } from "@/lib/limits/errors";
import { limitsFlags } from "@/lib/limits/flags";

import { WRAPPER_ERR } from "@/lib/wrapper-errors";
export type MarketTxAction = "open" | "close" | "deposit" | "withdraw" | "earn-deposit" | "earn-withdraw";

// No refill promise: nothing in the app can re-fund the counterparty of a non-vault market (GH#2882).
export const MSG_LP_DEPLETED_OPEN =
  "The market doesn't have enough funds to take the other side of new trades, so new positions can't open right now. " +
  "Closing works normally.";
export const MSG_RESOLVED =
  "This market is resolved. New positions can't be opened; you can still close positions and withdraw.";
export const MSG_RECOVERY = "This market is in recovery mode. New positions are blocked until it recovers.";
export const MSG_REPAIRABLE =
  "Market temporarily locked by an expired backing bucket or a side waiting to reset. " +
  "Try again: your next transaction includes the repair automatically.";
export const MSG_LOSS_STALE =
  "Positions on this market are being refreshed after a price move. New trades wait until that finishes.";
export const MSG_ADL_REDUCE_ONLY_OPEN =
  "This market is reduce-only while it recovers from a bankruptcy, so new positions are paused. Closing positions still works. New positions reopen once the positions on one side have closed, which depends on those traders and can take a while.";
export const MSG_ADL_REDUCE_ONLY_CLOSE =
  "This market is reduce-only while it recovers from a bankruptcy. Closing still works: try the close again and it is sent as a unilateral exit you sign yourself.";
export const MSG_DRAIN_ONLY = "This side of the market only accepts position-reducing trades right now.";

const OPENING: readonly MarketTxAction[] = ["open"];

function has(h: MarketHealthRow, r: LockReason): boolean {
  return h.lockReasons.includes(r);
}

/**
 * Hook for P1 codes (band, halt, exposure cap) and P3 (provisional ordinals,
 * flag-gated, read from lib/limits/constants.ts). P1 66..71 already have copy
 * in errorMessages.P1_ERROR_MESSAGES; this only refines by live health, and
 * adds P3 copy (P3 ordinals are not in ERROR_CODE_MAP because they will move).
 * Returns null = no refinement.
 */
export function refineP1(code: number, action: MarketTxAction, health: MarketHealthRow | null): string | null {
  // 69 LpFloorHalt / 68 LpExposureCapExceeded on an open with a depleted LP: the
  // honest message is "LP depleted", same as the pre-P1 Custom(49) state.
  if ((code === WRAPPER_ERR.LpFloorHalt || code === WRAPPER_ERR.LpExposureCapExceeded) && action === "open" && health?.lpDepleted) return MSG_LP_DEPLETED_OPEN;
  if (limitsFlags().p3) return p3LimitsErrorCopy(code);
  return null;
}

/**
 * Better message for a failed market tx, or null to keep humanizeError's.
 * Pure: pass the market health you already have (useSingleMarketHealth).
 */
export function explainMarketTxError(
  raw: string,
  action: MarketTxAction,
  health: MarketHealthRow | null | undefined,
): string | null {
  if (detectWalletError(raw)) return null; // wallet lock / rejection: humanizeError owns it
  const code = extractErrorCode(raw);
  if (code === null) return null;
  const origin = failingProgramId(raw);
  if (origin && origin !== resolveDevnetProgramIds().wrapper) return null; // matcher/stake/SPL codes are not ours
  if (code === WRAPPER_ERR.Unauthorized) return null; // genuine program Unauthorized — never refined into "locked"
  const p1 = refineP1(code, action, health ?? null);
  if (p1) return p1;
  if (!health) return null;

  const opening = OPENING.includes(action);
  if (code === WRAPPER_ERR.EngineLockActive || code === WRAPPER_ERR.EngineStale) {
    if (has(health, "resolved")) return opening ? MSG_RESOLVED : null;
    if (has(health, "recovery")) return MSG_RECOVERY;
    if (has(health, "repairable")) return MSG_REPAIRABLE;
    if (code === WRAPPER_ERR.EngineLockActive && has(health, "adl-reduce-only")) return opening ? MSG_ADL_REDUCE_ONLY_OPEN : MSG_ADL_REDUCE_ONLY_CLOSE;
    if (code === WRAPPER_ERR.EngineLockActive && opening && health.lpDepleted) return MSG_LP_DEPLETED_OPEN;
    if (code === WRAPPER_ERR.EngineLockActive && has(health, "loss-stale")) return MSG_LOSS_STALE;
    if (code === WRAPPER_ERR.EngineLockActive && opening && has(health, "drain-only")) return MSG_DRAIN_ONLY;
    return null;
  }
  if (code === WRAPPER_ERR.EngineInsufficientInitialMargin && opening && health.lpDepleted) return MSG_LP_DEPLETED_OPEN;
  return null;
}

/** explainMarketTxError that never throws (callers are error paths themselves). */
export function safeExplainMarketTxError(
  raw: string,
  action: MarketTxAction,
  health: MarketHealthRow | null | undefined,
): string | null {
  try {
    return explainMarketTxError(raw, action, health);
  } catch {
    return null;
  }
}
