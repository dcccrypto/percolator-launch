/** Pure view logic of "Add capital at a discount" on an impaired Earn vault. */
import { RESCUE_MIN_ATOMS_V22, quoteRescueV22, rescueAdmittedV22, type RescueQuote } from "./sdk";

export interface RescueReadings {
  /** The impaired senior value the shares exit at now (Earn tranche view `senior`). null = unknown. */
  v: bigint | null;
  /** What those shares are owed at par (the senior claim). */
  par: bigint;
  /** Senior shares outstanding. */
  shares: bigint;
}

export interface RescueView {
  /** Show the action at all: impaired and not past the NAV floor. */
  visible: boolean;
  /** Impaired beyond recapitalisation: show the calm wind-down line instead of an action. */
  wound: boolean;
  /** Atoms of collateral per share at the impaired value, as a decimal number (display only). */
  pricePerShare: number | null;
  /** Smallest rescue, atoms. */
  minAtoms: bigint;
}

export function rescueView(r: RescueReadings | null, shareDecimals = 6, collateralDecimals = 6): RescueView {
  const none: RescueView = { visible: false, wound: false, pricePerShare: null, minAtoms: RESCUE_MIN_ATOMS_V22 };
  if (!r || r.v === null || r.shares === 0n || r.par === 0n) return none;
  if (r.v >= r.par) return none;
  // Probe the admission with the smallest legal amount: only NavFloor / Shape matter for visibility.
  const probe = rescueAdmittedV22(RESCUE_MIN_ATOMS_V22, r.v, r.par, r.shares);
  if (probe === "NavFloor") return { ...none, wound: true };
  if (probe === "Shape") return none;
  const price = (Number(r.v) / 10 ** collateralDecimals) / (Number(r.shares) / 10 ** shareDecimals);
  return { visible: true, wound: false, pricePerShare: Number.isFinite(price) ? price : null, minAtoms: RESCUE_MIN_ATOMS_V22 };
}

export function rescueQuote(r: RescueReadings, amount: bigint, slippageBps = 50): RescueQuote | null {
  if (r.v === null || amount <= 0n) return null;
  return quoteRescueV22({ amount, v: r.v, par: r.par, shares: r.shares, seniorClaim: r.par, slippageBps });
}
