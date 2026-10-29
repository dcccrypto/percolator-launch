/**
 * The Earn figures a depositor sees (TVL, Share value, Your Value; Earned via lib/lp-earned.ts),
 * from ONE source of truth: the pricing the withdraw preview uses.
 *
 * App bug 2026-10-29 (product review finding 3, R1): on a BOUND (P3) vault these were registry
 * shares + distributed fees, which can only go up, so a loss never showed while the withdraw quote
 * (tag 77, the program's senior value) did. A bound vault is now priced only by `earnPanelPricing`
 * (earn-pricing.ts, the port of 75/77): value = senior_atoms_for_redemption(shares, S, senior), the
 * same function as previewWithdrawAtoms. No price (limits unread, stale certificate not yet
 * simulated) is unknown ("—"), never the proxy.
 *
 * Non-bound vaults pass through: a two-pot vault's state is already the program's combined NAV
 * (useInsuranceLP), and a legacy registry is priced at shares + fees by the program itself.
 */
import { previewWithdrawAtoms } from "./earn-withdraw";
import { seniorSharePriceE6 } from "./vault-tranche";

export interface EarnDisplayState {
  /** The registry is bound to the market's vault LP (useInsuranceLP). */
  bound?: boolean;
  userLpBalance: bigint;
  pendingRedemptionShares: bigint;
  lpSupply: bigint;
  vaultTotalAtoms: bigint;
  vaultSharePriceE6: bigint;
  userVaultValueAtoms: bigint;
  splitPot: { totalShares: bigint } | null;
}

/** The slice of earnPanelPricing / withSplitPotPricing the figures need. */
export interface EarnWithdrawPricing {
  totalShares: bigint;
  withdrawSeniorValue: bigint | null;
}

export interface EarnDisplay {
  /** The share count the figures are spread over (registry shares on a bound / two-pot vault). */
  totalShares: bigint | null;
  /** What every Earn share redeems for together. */
  tvlAtoms: bigint | null;
  /** Collateral per share, e6. */
  sharePriceE6: bigint | null;
  /** The wallet's shares (held + escrowed in a pending withdrawal) at the withdraw price. */
  userValueAtoms: bigint | null;
}

const UNKNOWN = { tvlAtoms: null, sharePriceE6: null, userValueAtoms: null } as const;

export function earnDisplayFigures(state: EarnDisplayState, pricing: EarnWithdrawPricing | null): EarnDisplay {
  if (!state.bound) {
    return {
      totalShares: state.splitPot?.totalShares ?? state.lpSupply,
      tvlAtoms: state.vaultTotalAtoms,
      sharePriceE6: state.vaultSharePriceE6,
      userValueAtoms: state.userVaultValueAtoms,
    };
  }
  if (!pricing) return { totalShares: null, ...UNKNOWN };
  const senior = pricing.withdrawSeniorValue;
  const total = pricing.totalShares;
  if (senior === null || total <= 0n) return { totalShares: total, ...UNKNOWN };
  const held = state.userLpBalance + state.pendingRedemptionShares;
  return {
    totalShares: total,
    tvlAtoms: senior,
    sharePriceE6: seniorSharePriceE6(senior, total),
    userValueAtoms: held > 0n ? previewWithdrawAtoms(held, total, senior) : 0n,
  };
}
