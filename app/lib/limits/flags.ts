import { isDevnetV22Enabled } from "@/lib/v22/flag";

/**
 * Phase flags for the limits UI (plan §3). Build-time `NEXT_PUBLIC_*`, inlined
 * by Next — each read must be a literal `process.env.NEXT_PUBLIC_X` access so
 * the bundler can substitute it. Default OFF: the live devnet program (v18.2)
 * enforces none of these rules, and its P1/P3 bytes read all-zero, so showing
 * the panels there would display limits that are not enforced.
 */
export interface LimitsFlags {
  p1: boolean;
  p2: boolean;
  /** The wrapper charges the matcher's requested fee (P2-4). Never implied by p2. */
  p2FeeCharged: boolean;
  p3: boolean;
}

const on = (v: string | undefined): boolean => v === "1" || v === "true";

export function readLimitsFlags(): LimitsFlags {
  return {
    p1: on(process.env.NEXT_PUBLIC_LIMITS_P1),
    p2: on(process.env.NEXT_PUBLIC_LIMITS_P2),
    p2FeeCharged: on(process.env.NEXT_PUBLIC_LIMITS_P2_FEE_CHARGED),
    p3: on(process.env.NEXT_PUBLIC_LIMITS_P3),
  };
}

/** Test/override seam: `null` = read env. */
let override: LimitsFlags | null = null;
export function __setLimitsFlagsForTest(f: LimitsFlags | null): void {
  override = f;
}
export function limitsFlags(): LimitsFlags {
  return override ?? readLimitsFlags();
}

/**
 * Council GO1106-UX #2: Earn prices a BOUND vault the P3 way (registry shares, senior value) when P3 is on OR on a
 * v2.2 build. The v2.2 wrapper writes the vault-LP `bound` byte itself, so a bound vault there is priced by the P3
 * rules whether or not the P3 UI flag was set on the deployment (the v2.2 preview has no NEXT_PUBLIC_LIMITS_P3, and
 * every Earn vault read "—" / "can't be valued right now"). Earn reads only; the ticket and wizard keep `p3`.
 * A pre-P3 program reads its bound byte as 0, so this never prices a legacy vault as bound.
 */
export function earnP3Enabled(flags: Pick<LimitsFlags, "p3"> = limitsFlags()): boolean {
  return flags.p3 || isDevnetV22Enabled();
}

/**
 * The create-market wizard binds new markets the P3 way (vault-owned LP + junior tranche) when
 * P3 is on. Kill switch NEXT_PUBLIC_LIMITS_P3_WIZARD=0 keeps the legacy creator-LP launch while
 * the rest of the P3 UI stays on (e.g. to pause new vault-LP markets while the auto-pinned
 * caps are reviewed).
 */
export function p3WizardEnabled(): boolean {
  if (!limitsFlags().p3) return false;
  const v = process.env.NEXT_PUBLIC_LIMITS_P3_WIZARD?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
