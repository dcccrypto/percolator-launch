/**
 * #2643 — disambiguate `Custom(9)` on a trade using PRE-TRADE STATE.
 *
 * `Custom(9)` is `PercolatorError::InvalidInstruction` on the deployed v18.2
 * wrapper. Every reason `handle_trade_cpi` (v16_program.rs) can return it:
 *
 *   1. matcher ctx not usable: `matcher_prog` not executable / is the wrapper,
 *      `matcher_ctx` executable / not owned by the matcher / < 64 bytes
 *      (a market whose matcher was never initialised)                 [state]
 *   2. `cfg.trade_fee_base_bps > fee_bps`, or fee floor > max fee    [fee param]
 *   3. `backing_fee_cap_bps > 10_000`                               [fee param]
 *   4. `trade_fee_base_bps > lp_trade_fee_cap_bps` (LP never consented to the
 *      market's base fee)                                              [LP cfg]
 *   5. matcher tail account is a signer / aliases a trusted account or is
 *      wrapper-owned, or the tail is over MAX_MATCHER_TAIL_ACCOUNTS  [client bug]
 *   6. `size_q == 0` / `i128::MIN`                                    [client bug]
 *   7. `oracle_price == 0` (no mark published yet)                     [state]
 *   8. post-fill `exec_price` outside the taker's `limit_price`
 *      (a genuine slippage rejection)                                  [price]
 *   Same-code twins in the trade-adjacent paths: TradeNoCpi / batch reject
 *   `account_a == account_b`, `fee_bps` below base, `backing_fee_cap_bps`
 *   > 10_000; batch adds source-domain-capacity limits.
 * The matcher program (percolator-match) never returns Custom(9): its own
 * failures are standard ProgramErrors, and `validate_matcher_return` failures
 * (incl. over-cap fills) are `InvalidAccountData`, not code 9.
 *
 * The code alone cannot tell (1)/(7) from (8), so the UI used to guess
 * "slippage". This module resolves what CAN be resolved before/after the fact:
 *   - matcher ctx not ready       -> cause 1 is proven
 *   - market never finished setup -> reported as such (NOT proven to be the
 *     cause: the stake pool is the wizard's LAST step, after the matcher, so an
 *     incomplete market can still trade — hence the softer wording)
 *   - otherwise                   -> undetermined: keep the honest generic text.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { readMatcherContextReadiness } from "@/lib/matcherCaps";
import { getConfig } from "@/lib/config";
import { isWrapperAccount } from "@/lib/v22/layout";

export interface PreTradeState {
  /** marketauth rotated to the stake-pool PDA; null = could not be read. */
  complete: boolean | null;
  matcher: "ready" | "not-ready" | "unknown";
}

export type Custom9Cause = "matcher-uninitialised" | "market-incomplete" | "undetermined";

/** True for a PercolatorError::InvalidInstruction (code 9) in any of the error
 *  shapes the RPC / wallet layers produce. Exact-9 only (not 90, 0x90 ...). */
export function isCustom9Error(raw: string): boolean {
  return (
    /Custom\(9\)/.test(raw) ||
    /"Custom"\s*:\s*9(?!\d)/.test(raw) ||
    /custom program error:\s*0x9(?![0-9a-fA-F])/i.test(raw)
  );
}

export function classifyCustom9(state: PreTradeState): Custom9Cause {
  if (state.matcher === "not-ready") return "matcher-uninitialised";
  if (state.complete === false) return "market-incomplete";
  return "undetermined";
}

/** User-facing text per cause; null = keep the caller's generic message. */
export function custom9Message(cause: Custom9Cause): string | null {
  switch (cause) {
    case "matcher-uninitialised":
      return (
        "This market can't be traded yet: its liquidity matcher was never set up, so the program " +
        "rejected the trade. Market creation didn't finish. If you created it, resume from My Markets; " +
        "otherwise choose another market."
      );
    case "market-incomplete":
      return (
        "The program rejected this trade, and this market never finished being created, so it may " +
        "not be tradeable yet. If you created it, finish setup from My Markets; otherwise choose " +
        "another market. (This is not a slippage problem.)"
      );
    default:
      return null;
  }
}

/** Read the pre-trade state on demand (failure path only). Never throws. */
export async function readPreTradeState(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
  matcherProgramId: PublicKey | null,
): Promise<PreTradeState> {
  let complete: boolean | null = null;
  try {
    const info = await connection.getAccountInfo(slabPk, "confirmed");
    if (info) {
      const data = new Uint8Array(info.data);
      if (isWrapperAccount(data)) {
        const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
        complete = isMarketauthComplete(cfg.marketauth, slabPk);
      }
    }
  } catch {
    complete = null;
  }
  const matcher = matcherProgramId
    ? await readMatcherContextReadiness(connection, programId, slabPk, matcherProgramId)
    : "unknown";
  return { complete, matcher };
}

/**
 * Best user-facing message for a failed trade, or null to keep the generic one.
 * Only acts on Custom(9); every other error passes through untouched.
 * `deadlineMs` bounds the extra reads so the error banner is never held hostage.
 */
export async function diagnoseTradeRejection(
  rawMsg: string,
  connection: Connection,
  programId: PublicKey | null | undefined,
  slabPk: PublicKey,
  deadlineMs = 4000,
): Promise<string | null> {
  if (!isCustom9Error(rawMsg) || !programId) return null;
  let matcherProgramId: PublicKey | null = null;
  try {
    const id = (getConfig() as { matcherProgramId?: string }).matcherProgramId;
    if (id) {
      matcherProgramId = new PublicKey(id);
    }
  } catch {
    matcherProgramId = null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = await Promise.race([
    readPreTradeState(connection, programId, slabPk, matcherProgramId),
    new Promise<PreTradeState>((resolve) => {
      timer = setTimeout(() => resolve({ complete: null, matcher: "unknown" }), deadlineMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return custom9Message(classifyCustom9(state));
}
