import { keepAppMessage, plainMessage, resolveUserMessage, type MessageContext, type UserMessage } from "@/lib/limits/user-message";

/**
 * User-facing copy for a failed Earn (LP vault) action.
 *
 * The generic `ERROR_CODE_MAP` copy is written for trading and is wrong or
 * silent here: the Earn panel used to show the raw `err.message`, so a vault
 * the market had locked read as an opaque "custom program error: 0x15".
 * Codes below are the deployed wrapper's (percolator-prog v18.2 `6377376a`)
 * `PercolatorError` ordinals as returned by DepositToLpVault (tag 75) and
 * ExecuteRedemption (tag 77):
 *
 *  21 EngineLockActive —
 *     deposit: the vault's backing pot is not in a state that can take new
 *       backing (`add_fresh_counterparty_backing_view`: the bucket is Fresh
 *       with a finite expiry — a realized-loss reservation the market opened
 *       — or lapsed / impaired), or the market is not Live. It clears when the
 *       keeper expires the lapsed bucket or the window ends; nothing the user
 *       can change fixes it.
 *     claim: paying the full redemption would leave the pot under-backed
 *       against traders' outstanding unrealized PnL (the stay-fully-backed
 *       `credit_rate_num == CREDIT_RATE_SCALE` gate), or the pot is not Fresh.
 *       It clears as those positions settle.
 *  19 EngineStale — the market's engine clock is behind (not cranked).
 *  36 LpVaultCooldownActive — the redemption cooldown has not elapsed.
 *  37 LpVaultOiReservationViolated — the payout would leave less than the
 *     vault's reservation threshold covering open interest.
 *  NotEnoughAccountKeys — the client sent a stale account list (a client bug,
 *     not the user's fault; see useInsuranceLP ExecuteRedemption).
 */
export type EarnAction = "deposit" | "claim";

/** What the caller knows about the vault. `p3Bound`: the vault owns its market's LP (P3). */
export interface EarnErrorContext {
  p3Bound?: boolean;
}

/** The full message (title, body, action, details) for a failed Earn action (§5.3). */
export function earnUserMessage(err: unknown, action: EarnAction, ctx: EarnErrorContext & Omit<MessageContext, "surface"> = {}): UserMessage {
  return resolveUserMessage(err, { ...ctx, surface: action === "deposit" ? "earn-deposit" : "earn-withdraw" });
}

/**
 * The one line for a failed Earn action. UX WP-1: delegates to the single resolver
 * (lib/limits/user-message.ts), so every P3 code (74/84/85/87/88/89, 21 on a bound claim)
 * and every wallet/network condition gets its plain line; nothing reaches the user as
 * "Program error" / "Custom(n)" (those are in the StatusLine's Details).
 */
export function earnErrorMessage(err: unknown, action: EarnAction, ctx: EarnErrorContext = {}): string {
  return earnUserMessage(err, action, ctx).body;
}

/** /stake's line for a timed-out deposit or withdraw: nothing there watches the signature. */
export const STAKE_STILL_CONFIRMING = "Still confirming. It may still land, so check your balance before trying again.";

/**
 * #26: the one line for a failed /stake (insurance LP) deposit or withdraw: the resolver's plain
 * line, the app's own plain messages kept, never the raw simulation text or program logs. The
 * resolver's timeout line ("We'll update this when it lands") is replaced, since /stake doesn't watch.
 */
export function stakeErrorMessage(err: unknown): string {
  if (resolveUserMessage(err, { surface: "stake" }).kind === "still-confirming") return STAKE_STILL_CONFIRMING;
  return plainMessage(err, { surface: "stake" }, keepAppMessage);
}
