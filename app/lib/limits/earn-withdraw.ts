/**
 * UX WP-4 (audit §3.6, user decision 2026-09-30): Earn withdrawal as ONE flow over two
 * signatures. The redemption cooldown stays (a cooldown of 0 lets a leaver front-run a loss onto
 * the seniors who stay), so:
 *   request (76) -> "Withdrawal in progress: X USDC · Ready in m:ss" -> when the cooldown ends,
 *   the payout (77, pre-simulated, repairs bundled by sendTx) opens by itself; after a reload the
 *   card says "Finish withdrawal". Only a vault whose cooldown is 0 withdraws in one tx [76, 77].
 *
 * Pricing: during a price catch-up the wrapper (ede691b6) prices Earn exits / entries at the
 * worse of the effective and the pending target price; the ONE port of that rule is
 * lib/limits/earn-pricing.ts `earnSeniorPricing`, and every preview here consumes its output.
 * Pure; unit-tested in __tests__/lib/limits/earn-withdraw.test.ts.
 */
import type { EarnTrancheView } from "./vault-tranche";
import { recallLimit, seniorAtomsForRedemption, seniorSharesForDeposit } from "./vault-tranche";

/** Devnet slot time used for every cooldown-to-clock conversion. */
export const SLOT_MS = 400;

export type WithdrawFlow = "one-tx" | "two-step";

/** The registry's cooldown decides the flow: 0 => [76, 77] in one tx; otherwise two steps. */
export function withdrawFlow(cooldownSlots: bigint): WithdrawFlow {
  return cooldownSlots <= 0n ? "one-tx" : "two-step";
}

/** Shares a deposit of `usdcAtoms` mints against the deposit claim (75: amount * S / C_price). */
export function previewDepositShares(usdcAtoms: bigint, totalShares: bigint, depositClaim: bigint | null): bigint | null {
  if (depositClaim === null) return null;
  return seniorSharesForDeposit(usdcAtoms, totalShares, depositClaim);
}

/** Wrapper `LP_VAULT_MINIMUM_LIQUIDITY`: the genesis deposit's dead shares (never minted to anyone). */
export const LP_VAULT_MINIMUM_LIQUIDITY = 1_000n;

const U64_MAX = (1n << 64n) - 1n;

/**
 * What tag 75 actually MINTS to the depositor, or null when the program refuses the deposit
 * (prog#627 family: a share price over a zero / dust base must never preview as 1:1):
 *  - genesis (`totalShares == 0`): `amount - LP_VAULT_MINIMUM_LIQUIDITY`, refused if that is <= 0
 *    (LpVaultDepositBelowMinimumLiquidity);
 *  - shares outstanding at a zero price: refused (the senior value is 0);
 *  - a deposit that floors to 0 shares: refused (LpVaultZeroSharesMinted).
 */
export function previewDepositSharesMinted(usdcAtoms: bigint, totalShares: bigint, depositClaim: bigint | null): bigint | null {
  // amount_to_u64 / u64::try_from(shares_to_mint): above u64 the program refuses (overflow).
  if (usdcAtoms <= 0n || usdcAtoms > U64_MAX) return null;
  if (totalShares === 0n) {
    const minted = usdcAtoms - LP_VAULT_MINIMUM_LIQUIDITY;
    return minted > 0n ? minted : null;
  }
  const shares = previewDepositShares(usdcAtoms, totalShares, depositClaim);
  return shares !== null && shares > 0n && shares <= U64_MAX ? shares : null;
}

/** Why tag 75 would refuse a deposit, or null when it would mint (or the price is unknown). */
export type DepositRefusal = "genesis-minimum" | "no-value" | "zero-shares" | "too-large";

export function depositRefusalReason(usdcAtoms: bigint, totalShares: bigint, depositClaim: bigint | null): DepositRefusal | null {
  if (usdcAtoms <= 0n) return null;
  if (usdcAtoms > U64_MAX) return "too-large";
  if (totalShares === 0n) return usdcAtoms > LP_VAULT_MINIMUM_LIQUIDITY ? null : "genesis-minimum";
  if (depositClaim === null) return null; // unknown pricing is not a refusal
  if (depositClaim === 0n) return "no-value";
  const shares = previewDepositShares(usdcAtoms, totalShares, depositClaim);
  if (shares === null || shares === 0n) return "zero-shares";
  return shares > U64_MAX ? "too-large" : null;
}

/** USDC `shares` redeem for at the (withdraw-side) senior value. */
export function previewWithdrawAtoms(shares: bigint, totalShares: bigint, seniorValue: bigint | null): bigint | null {
  if (seniorValue === null || shares <= 0n) return null;
  return seniorAtomsForRedemption(shares, totalShares, seniorValue);
}

/** The shares that redeem for at most `usdcAtoms` (floor; never more than the user holds). */
export function sharesForUsdc(usdcAtoms: bigint, totalShares: bigint, seniorValue: bigint | null, heldShares: bigint): bigint | null {
  if (seniorValue === null || seniorValue <= 0n || totalShares <= 0n || usdcAtoms <= 0n) return null;
  const s = (usdcAtoms * totalShares) / seniorValue;
  return s > heldShares ? heldShares : s;
}

/**
 * What the vault can pay out NOW without waiting for open trades to close (audit §3.6 item 6):
 * the pots + harvestable fees, plus what a recall (98) can pull from the LP: the recall limit
 * capped at the LP's value, and 0 while a senior draw is pending (D-P3-30). null = unknown.
 */
export function maxNowAtoms(view: EarnTrancheView | null, lpValueAtoms: bigint | null, drawPending: boolean): bigint | null {
  if (!view) return null;
  if (!view.illiquid) return null; // the pots cover every senior: no cap to show
  const recall = drawPending ? 0n : recallLimit(view.seniorClaimEff, view.backingCover);
  const fromLp = lpValueAtoms === null ? 0n : recall < lpValueAtoms ? recall : lpValueAtoms > 0n ? lpValueAtoms : 0n;
  return view.backingCover + fromLp;
}

export type PendingPhase = "counting" | "ready" | "collecting";

/** "1:05" / "0:08". */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "about a minute" / "a few seconds" for the request line (§3.6 item 2). */
export function cooldownPhrase(cooldownSlots: bigint): string {
  const secs = Number(cooldownSlots) * (SLOT_MS / 1000);
  if (secs <= 15) return "a few seconds";
  if (secs < 50) return `about ${Math.round(secs / 5) * 5} seconds`;
  if (secs <= 90) return "about a minute";
  return `about ${Math.round(secs / 60)} minutes`;
}

export const EARN_WITHDRAW_COPY = {
  pendingTitle: (amount: string) => `Withdrawal in progress: ${amount}`,
  readyIn: (clock: string) => `Ready in ${clock}`,
  ready: "Ready to collect",
  collecting: "Collecting…",
  finish: "Finish withdrawal",
  payoutPrompt: "Approve payout (2 of 2)",
  requestButton: (amount: string) => `Withdraw ${amount}`,
  requestLine: (phrase: string, approvals: 1 | 2) => `Arrives in ${phrase} · ${approvals} approval${approvals === 1 ? "" : "s"}`,
  receive: (usdc: string, shares: string) => `You receive ≈ ${usdc} (${shares} shares)`,
  maxNow: (max: string) =>
    `Part of this vault's money is in use by open trades right now. You can withdraw up to ${max} now, or the rest once those trades close.`,
  maxNowAction: (max: string) => `Withdraw ${max}`,
  depositPreview: (shares: string, pct: string) => `You'll get ≈ ${shares} shares (${pct} of the vault)`,
  /** Tag 75 would refuse this amount; one line per reason (`depositRefusalReason`). */
  depositRefused: {
    "genesis-minimum": "Too small for this vault's first deposit (a tiny amount stays locked in the vault). Try a larger amount.",
    "no-value": "This vault has no value left to price new shares against, so it can't take deposits right now.",
    "zero-shares": "Too small: this amount would mint no shares. Try a larger amount.",
    "too-large": "Too large for one deposit at this vault's share price. Try a smaller amount.",
  } as Record<DepositRefusal, string>,
  /** Two-pot vault: the full pending amount can't be paid in one go right now (Custom 21 / 25 before signing). */
  maxAvailableTitle: "Partly available now",
  maxAvailableBody: "The full amount can't be paid in one go right now. Nothing moved. You can withdraw the max available now; the rest stays in the vault.",
  maxAvailableAction: (max: string) => `Withdraw max available now: ${max}`,
} as const;
