/**
 * The launch wizard's "Advanced: leverage tiers" (pure). A band (tiered) market earns higher leverage as its pool depth and market
 * backing pass thresholds; the protocol defaults are 5x at $25k, 10x at $100k, 20x at $500k (never above the market's own maximum).
 * A creator may edit the thresholds and the maximum leverage per tier inside the program's bounds; this module parses the form,
 * runs the SDK's `validateTierConfig` (the wrapper's exact verdict, so the chain's error 130 is never the first sighting) and
 * builds the tag-94 tier block. Blank = the protocol default.
 */
import {
  GROWTH_MAX_COLLATERAL_DECIMALS,
  TIER_LEVERAGE_DEFAULT_X100,
  growthCollateralDecimalsOk,
  TIER_THRESHOLD_DEFAULT_USD,
  TIER_THRESHOLD_FLOOR_USD,
  tierLeverage,
  validateTierConfig,
  type TierConfig,
  type TierConfigIssue,
} from "./sdk/records/growth-v19";
import { V22_COPY } from "./copy";

export type Triple3<T> = readonly [T, T, T];

/**
 * The market's collateral, for wording. Tier amounts are whole COLLATERAL TOKENS (scaled on chain by the mint's decimals): "$" is said
 * only for a 6-decimal USD-like token (the test USDC); any other collateral is named by its symbol (or "tokens").
 */
export interface TierCollateral {
  decimals?: number;
  symbol?: string;
  usdLike?: boolean;
}

/** Default for the app's own collateral (the universal test USDC). */
export const TEST_USDC: TierCollateral = { decimals: 6, symbol: "USDC", usdLike: true };

/** USD-like = a 6-decimal token whose symbol says USD (USDC, USDT, sim-USDC). */
export const isUsdLikeCollateral = (symbol: string | undefined, decimals: number): boolean => decimals === 6 && /usd/i.test(symbol ?? "");

const dollarsOnly = (c: TierCollateral): boolean => (c.decimals ?? 6) === 6 && c.usdLike === true;

/** "$25k" on USD-like collateral, else "25k TOK" ("25k tokens" with no symbol). */
export function amountLabel(n: number, c: TierCollateral = TEST_USDC): string {
  const short = n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1_000 ? `${n / 1_000}k` : `${n}`;
  return dollarsOnly(c) ? `$${short}` : `${short} ${c.symbol ?? "tokens"}`;
}

/** The form state: text boxes for the thresholds (whole dollars), leverage picks as x100 text ("" = default). */
export interface TierEdit {
  thresholds: Triple3<string>;
  leverage: Triple3<string>;
}

export const EMPTY_TIER_EDIT: TierEdit = { thresholds: ["", "", ""], leverage: ["", "", ""] };

export type TierField = "thresholds" | "leverage" | "collateral";

export interface TierEditIssue {
  field: TierField;
  /** 1..3 when the problem belongs to one tier's field; absent for a whole-form problem. */
  tier?: 1 | 2 | 3;
  message: string;
}

export interface TierEditResult {
  /** True when the form is empty (protocol defaults) or valid. */
  ok: boolean;
  /** The block to put on the wire; undefined when the form is empty (the plain bind means the defaults). */
  config?: TierConfig;
  issues: TierEditIssue[];
}

const toInt = (s: string): number | null => {
  const t = s.trim().replace(/[$,\s]/g, "");
  if (t === "") return 0;
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
};

/** Parse a leverage text such as "7", "7.5" or "750" (x100) into x100; blank = 0 = default. */
const levToX100 = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/** Parse and validate the form against the market's launch leverage and built-in maximum (both x100). */
/** D-L1: collateral above 12 decimals cannot back a leveraged market. One calm line, or null. */
export function collateralDecimalsIssue(decimals: number): string | null {
  return growthCollateralDecimalsOk(decimals) ? null : V22_COPY.tiers.collateralDecimals(GROWTH_MAX_COLLATERAL_DECIMALS);
}

export function validateTierEdit(edit: TierEdit, lLaunchX100: number, lTierX100: number, collateral: TierCollateral = TEST_USDC): TierEditResult {
  const decimalsIssue = collateralDecimalsIssue(collateral.decimals ?? 6);
  if (decimalsIssue) return { ok: false, issues: [{ field: "collateral", message: decimalsIssue }] };
  const issues: TierEditIssue[] = [];
  const th: number[] = [];
  const lv: number[] = [];
  edit.thresholds.forEach((s, k) => {
    const v = toInt(s);
    if (v === null) issues.push({ field: "thresholds", tier: (k + 1) as 1 | 2 | 3, message: `Tier ${k + 1} pool depth must be a whole number of ${dollarsOnly(collateral) ? "dollars" : (collateral.symbol ?? "tokens")}.` });
    th.push(v ?? 0);
  });
  edit.leverage.forEach((s, k) => {
    const v = levToX100(s);
    if (v === null) issues.push({ field: "leverage", tier: (k + 1) as 1 | 2 | 3, message: `Tier ${k + 1} leverage must be a number such as 7 or 7.5.` });
    lv.push(v ?? 0);
  });
  if (issues.length > 0) return { ok: false, issues };
  const thresholdsUsd = th as unknown as [number, number, number];
  const leverageX100 = lv as unknown as [number, number, number];
  if (thresholdsUsd.every((v) => v === 0) && leverageX100.every((v) => v === 0)) return { ok: true, issues: [] };
  const r = validateTierConfig({ thresholdsUsd, leverageX100, lLaunchX100, lTierX100, collateral });
  const mapped: TierEditIssue[] = r.issues.map((i: TierConfigIssue) => ({
    field: i.field === "thresholds" ? "thresholds" : i.field === "collateral" ? "collateral" : "leverage",
    ...(i.tier ? { tier: i.tier } : {}),
    message: i.message,
  }));
  return r.ok ? { ok: true, config: { thresholdUsd: thresholdsUsd, leverageX100 }, issues: [] } : { ok: false, issues: mapped };
}

const lev = (x100: number): string => `${x100 % 100 === 0 ? x100 / 100 : (x100 / 100).toFixed(1)}x`;

/** The protocol defaults for THIS market, as one line: "5x at $25k · 10x at $100k · 20x at $500k pool depth and market backing". */
export function tierDefaultsLine(lLaunchX100: number, lTierX100: number, collateral: TierCollateral = TEST_USDC): string {
  const table = tierLeverage([0, 0, 0], lLaunchX100, lTierX100);
  return V22_COPY.tiers.defaults(
    [1, 2, 3].map((t) => `${lev(table[t] as number)} at ${amountLabel(TIER_THRESHOLD_DEFAULT_USD[t - 1] as number, collateral)}`).join(" · "),
  );
}

/** The leverage choices for a tier: whole and half steps from the launch leverage up to the market's own maximum (never above it). */
export function tierLeverageOptions(lLaunchX100: number, lTierX100: number): number[] {
  const out: number[] = [];
  for (let l = Math.ceil(lLaunchX100 / 50) * 50; l <= lTierX100; l += 50) out.push(l);
  if (lTierX100 >= lLaunchX100 && out[out.length - 1] !== lTierX100) out.push(lTierX100);
  return out;
}

export const TIER_FLOORS_USD = TIER_THRESHOLD_FLOOR_USD;
export const TIER_DEFAULT_LEVERAGE_X100 = TIER_LEVERAGE_DEFAULT_X100;
