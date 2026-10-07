/**
 * Pure v2.2 launch planning for the create-market wizard (no wallet, no RPC, no React).
 *
 * Turns what the creator knows (the token's price, the collateral decimals, the oracle mode, three
 * simple choices: price protection, holding fee, capacity bond) into the v2.2 InitMarket trailer
 * fields and the 107 dials, and into plain refusals with one calm line each. Protocol mechanics stay
 * invisible: nothing here is ever shown with its protocol name ("lot_exp", "band", "kink").
 *
 * Preconditions of the program (wave docs): lot / rent / band all ride the growth trailer
 * (`growth(4) [lot(1)] [rent(6) [band(18)]]`), so they exist only on a growth (P3, single-asset)
 * market priced by an AUTH_MARK oracle (a lot on Hybrid / EWMA is refused with 119).
 */
import {
  BAND_MIN_LEG_NOTIONAL_TOKENS_V22,
  LOT_EXP_MAX_V22,
  LOT_PRICE_FLOOR_E6_V22,
  MAX_ORACLE_PRICE_V22,
  assertBandBlockV22,
  assertBondConfigV22,
  assertRentBlockV22,
  bandDefaultsV22,
  bandGenesisPriceOkV22,
  bandMinWideAnchorV22,
  forcedRecoveryMinutesV22,
  lotExpForTokenPriceV22,
  type BandBlockV22,
  type InitBondTrancheArgs,
  type RentBlockV22,
} from "./sdk";
import { V22_COPY, fmtTokens } from "./copy";

/** The most a lot may cost: $10,000 per lot (the wrapper's documented window is $10 .. $10,000). */
export const LOT_PRICE_CEILING_E6 = 10_000_000_000n;

/** Holding fee default: `rent_max` 23 e9/slot (about 0.5% per day at a full side), kink 50% (design table example, wave B). */
export const DEFAULT_RENT: Readonly<RentBlockV22> = Object.freeze({ rentMaxE9PerSlot: 23, rentKinkBps: 5_000 });
/** Slots per day at 400 ms (216,000), for the "per day" line. */
export const SLOTS_PER_DAY = 216_000;
/** Bond defaults: 8% a year coupon cap, no utilisation bonus (must be 0), about one day of cooldown, 25% concentration cap. */
export const DEFAULT_BOND: Readonly<InitBondTrancheArgs> = Object.freeze({ couponBps: 800, utilBonusBps: 0, cooldownSlots: 216_000, capBps: 2_500 });

export type OracleModeV22 = "pyth" | "hyperp" | "keeper" | "admin";

/** The oracle modes that can carry a lot, a band and rent: authenticated-mark (keeper-pushed or creator-pushed). */
export const isAuthMarkMode = (m: OracleModeV22): boolean => m === "keeper" || m === "admin";
/** "Memecoin presets": a DEX-priced token the keeper pushes. Protection and the holding fee default ON there. */
export const isMemecoinPreset = (m: OracleModeV22): boolean => m === "keeper";

export type LaunchIssueCode =
  | "growth-required"
  | "oracle-unsupported"
  | "price-unknown"
  | "price-floor"
  | "price-ceiling"
  | "band-price-floor"
  | "band-invalid"
  | "rent-invalid"
  | "bond-invalid"
  | "bond-too-large";

export interface LaunchIssue {
  code: LaunchIssueCode;
  /** One calm line, ready to show. */
  message: string;
}

export interface LaunchPlanInput {
  /** USD price of ONE token, e6 (what the wizard already holds as `priceE6`). 0n = unknown. */
  tokenPriceE6: bigint;
  /** Collateral mint decimals (the band's minimum position is in whole collateral tokens). */
  collateralDecimals: number;
  /** Collateral symbol for the minimum-position line; omitted => "$". */
  collateralSymbol?: string;
  oracleMode: OracleModeV22;
  /** The growth (dynamic leverage) block is on: the v2.2 options ride its trailer. */
  growthOn: boolean;
  /** undefined = the default for this oracle mode (ON for memecoin presets). */
  protection?: boolean;
  holdingFee?: boolean;
  /** Capacity bond at launch; false/undefined = none. */
  bond?: boolean;
  /** Override the bond dials (advanced; not shown in the UI). */
  bondDials?: InitBondTrancheArgs;
}

export interface LaunchPlanV22 {
  /** The v2.2 block applies to this launch (growth on + AUTH_MARK oracle). False => nothing v2.2 is sent. */
  available: boolean;
  /** Effective toggles after defaults. */
  protection: boolean;
  holdingFee: boolean;
  bond: boolean;
  /** 0 = whole tokens are the unit (the no-lot form). Internal: never shown. */
  lotExp: number;
  /** Per-lot launch price, e6: what InitMarket and the mark use. Equals `tokenPriceE6 * 10^lotExp`. */
  perLotPriceE6: bigint;
  rent?: RentBlockV22;
  band?: BandBlockV22;
  bondArgs?: InitBondTrancheArgs;
  /** "Forced recovery after N minutes of keeper absence" (band on). */
  recoveryMinutes?: number;
  /** Minimum position in whole collateral tokens (band on). */
  minPositionTokens?: number;
  /** Sentences to show under the toggles, in order. */
  notes: string[];
  issues: LaunchIssue[];
}

const usd = (e6: bigint): string => `$${Number(e6) / 1e6 >= 1 ? fmtTokens(Number(e6) / 1e6) : (Number(e6) / 1e6).toString()}`;

/** `0.5%` style rate for the holding-fee line: e9 per slot at a full side, per day. */
export function holdingFeePctPerDay(r: Pick<RentBlockV22, "rentMaxE9PerSlot">): string {
  const pct = (r.rentMaxE9PerSlot * SLOTS_PER_DAY) / 1e9 * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export function planLaunchV22(i: LaunchPlanInput): LaunchPlanV22 {
  const issues: LaunchIssue[] = [];
  const notes: string[] = [];
  const memecoin = isMemecoinPreset(i.oracleMode);
  const protection = i.protection ?? memecoin;
  const holdingFee = i.holdingFee ?? memecoin;
  const bond = i.bond ?? false;
  const none: LaunchPlanV22 = {
    available: false, protection: false, holdingFee: false, bond: false, lotExp: 0, perLotPriceE6: i.tokenPriceE6, notes, issues,
  };
  if (!i.growthOn) return none;
  if (!isAuthMarkMode(i.oracleMode)) {
    // A lot cannot ride a Hybrid / EWMA mark (119), but the growth floor still applies: a growth market opens at
    // >= $10 per lot, and with no lot that means >= $10 per token. Nothing v2.2 is sent; only the clear refusal.
    if (i.tokenPriceE6 > 0n && i.tokenPriceE6 < LOT_PRICE_FLOOR_E6_V22) {
      issues.push({ code: "price-floor", message: V22_COPY.wizard.priceFloorNoLot });
    }
    return none;
  }

  // ── Lot size: automatic, from the token price ──────────────────────────
  if (i.tokenPriceE6 <= 0n) {
    issues.push({ code: "price-unknown", message: V22_COPY.wizard.priceUnknown });
    return { ...none, available: true, protection, holdingFee, bond, issues };
  }
  const k = lotExpForTokenPriceV22(i.tokenPriceE6);
  if (k === null) {
    issues.push({ code: "price-floor", message: V22_COPY.wizard.priceFloor(usd(LOT_PRICE_FLOOR_E6_V22)) });
    return { ...none, available: true, protection, holdingFee, bond, issues };
  }
  const perLot = i.tokenPriceE6 * 10n ** BigInt(k);
  if (perLot > LOT_PRICE_CEILING_E6) {
    issues.push({ code: "price-ceiling", message: V22_COPY.wizard.priceCeiling(usd(LOT_PRICE_CEILING_E6)) });
  }
  if (perLot > MAX_ORACLE_PRICE_V22) {
    // The engine caps a mark at 1e12 e6; nothing sensible to launch.
    if (!issues.some((x) => x.code === "price-ceiling")) issues.push({ code: "price-ceiling", message: V22_COPY.wizard.priceCeiling(usd(LOT_PRICE_CEILING_E6)) });
  }

  const out: LaunchPlanV22 = { available: true, protection, holdingFee, bond, lotExp: k, perLotPriceE6: perLot, notes, issues };

  // ── Price protection (band) ────────────────────────────────────────────
  // The grammar is `[rent [band]]`: a band needs a rent block. Protection ON without the holding fee still
  // sends the rent block with rent 0 (no fee), which the program accepts.
  if (protection || holdingFee) {
    const r: RentBlockV22 = holdingFee ? { ...DEFAULT_RENT } : { rentMaxE9PerSlot: 0, rentKinkBps: 0 };
    try {
      assertRentBlockV22(r);
      out.rent = r;
    } catch {
      issues.push({ code: "rent-invalid", message: "The holding fee setting isn't valid." });
    }
  }
  if (protection) {
    const b = bandDefaultsV22(i.collateralDecimals);
    try {
      assertBandBlockV22(b, i.collateralDecimals);
      out.band = b;
      out.recoveryMinutes = Math.round(forcedRecoveryMinutesV22(b));
      out.minPositionTokens = BAND_DEFAULT_MIN_TOKENS(b, i.collateralDecimals);
      if (!bandGenesisPriceOkV22(perLot, b.bandBps)) {
        const min = bandMinWideAnchorV22(b.bandBps);
        const need = min === null ? null : min * 100n;
        issues.push({ code: "band-price-floor", message: V22_COPY.wizard.priceFloor(need === null ? "more" : usd(need)) });
      }
      notes.push(V22_COPY.wizard.recovery(out.recoveryMinutes));
      notes.push(V22_COPY.wizard.minPosition(i.collateralSymbol ? `${fmtTokens(out.minPositionTokens)} ${i.collateralSymbol}` : `$${fmtTokens(out.minPositionTokens)}`));
    } catch {
      issues.push({ code: "band-invalid", message: "The price protection setting isn't valid." });
    }
  }

  // ── Bond tranche ───────────────────────────────────────────────────────
  if (bond) {
    const a = i.bondDials ?? { ...DEFAULT_BOND };
    try {
      assertBondConfigV22(a);
      out.bondArgs = a;
    } catch {
      issues.push({ code: "bond-invalid", message: "The bond setting isn't valid." });
    }
  }
  return out;
}

function BAND_DEFAULT_MIN_TOKENS(b: BandBlockV22, decimals: number): number {
  const whole = b.bandMinLegNotional / 10n ** BigInt(decimals);
  return Math.max(Number(whole), BAND_MIN_LEG_NOTIONAL_TOKENS_V22);
}

/** The plan's issues that block the launch (all of them: every issue is a refusal the program would also make). */
export const blockingIssue = (p: LaunchPlanV22): LaunchIssue | null => p.issues[0] ?? null;

/** The shape `CreateMarketParams.v22` carries into `useCreateMarket` (undefined when nothing v2.2 applies). */
export interface V22LaunchParams {
  lotExp: number;
  rent?: RentBlockV22;
  band?: BandBlockV22;
  bond?: InitBondTrancheArgs;
}

export function toLaunchParams(p: LaunchPlanV22): V22LaunchParams | undefined {
  if (!p.available || p.issues.length > 0) return undefined;
  return { lotExp: p.lotExp, ...(p.rent ? { rent: p.rent } : {}), ...(p.band ? { band: p.band } : {}), ...(p.bondArgs ? { bond: p.bondArgs } : {}) };
}

/** Display helper for a quiet tooltip: shown only when a lot is bigger than one token. */
export function lotTooltip(lotExp: number, symbol: string): string | null {
  if (lotExp <= 0 || lotExp > LOT_EXP_MAX_V22) return null;
  return `1 lot = ${(10 ** lotExp).toLocaleString("en-US")} ${symbol}`;
}
