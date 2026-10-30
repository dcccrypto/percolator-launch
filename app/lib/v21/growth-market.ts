/**
 * Growth-v19 market read model (pure). Turns the bytes the app already polls (market slab, the
 * vault LP portfolio) into what the ticket needs: the live max leverage per side, the capacity
 * numbers, and the utilisation fee to sign.
 *
 * FEATURE DETECTION. `AssetGrowthV19` lives at asset-slot [672, 792), which is all zero on every
 * market of today's programs ("all-zero means OFF"). `decodeGrowthRecord` returns null for those,
 * so a legacy market gets no growth view and the ticket is exactly what it is today. Nothing here
 * reads the network and nothing here throws on short or foreign bytes.
 */
import { ceilingImrBps, dynImrBps, isBankruptcyHlockActive, leverageX100ForImrBps, openingPartQ } from "./sdk";
// R2.1: the quote, the fee preview and their types are the v2.2 growth port (a superset: without `v22` input the quote is the growth-1 one).
import {
  previewGrowthOpenFee,
  quoteMaxLeverage,
  type AssetGrowthV19,
  type GrowthOpenFeePreview,
  type MaxLeverageQuote,
  type QuoteMaxLeverageInput,
} from "../v22/sdk/records/growth-v19";
import * as R2 from "../v22/sdk/records/growth-v19-r2";
import { clampEnforced, conservativeEquity } from "../v22/sdk/records/growth-v19";
import {
  GROWTH_FLAG_LEV_GUARD_V22,
  levGuardOpenLimitsV22,
  type LevGuardOpenInputV22,
  type LevGuardOpenLimitsV22,
  type LevGuardV22,
} from "../v22/sdk";
import { decodeAssetGrowthV19, decodeAssetVaultLpDrawP3 } from "../v22/records";
import { layoutOf } from "../v22/layout";
import { readBandRentView } from "../v22/band-rent-state";
import { parseV17RiskParams } from "../v17-engine-config";

/**
 * Absolute offset of the bankruptcy h-lock byte: `groupOff + (layout.group.mode - 5)`. 592 + 621 = 1213 on v2.1
 * (VERSION 18); the layout row moves it with the 48 B config growth on v2.2. Null when the account is not a
 * market of a known VERSION (flag on) so nothing is claimed.
 */
function hlockOffset(raw: Uint8Array): number | null {
  try {
    const L = layoutOf(raw, "readBankruptcyHlockActive");
    return L.marketGroupOff + (L.group.mode - 5);
  } catch {
    return null;
  }
}

/**
 * Whether the DEPLOYED wrapper (devnet 6kpg2wi7) applies the v2.2 growth depth rules (lambda_eff, kappa cap on N_cap, stored ratchet
 * ceiling). It does since 2026-10-15: the growth-tier commits (percolator-prog 557b2735, aa55dfde, 17536158) are ancestors of the
 * deployed aca02ba6 (on chain as c659c91d, ledger deployments.md), and `n_cap_g8_q` is what the TradeCpi room clip and the post-fill
 * gate read. With this false the ticket quoted `N_cap = C_m * lambda / P` (plain growth-1) on a tiered market where the program caps
 * at `min(that, kappa * depth / P)`: ~9,000x too much room on CHILLHOUSE-T / swordcat-T (see __tests__/lib/v22/growth-depth-real-bytes.test.ts).
 * Pinned to real account bytes there; flip back only if the deployed wrapper is rolled back to a build without growth tiers.
 */
export const GROWTH_DEPTH_RULES_DEPLOYED = true;

/**
 * App bug 2026-10-29 (product review findings 4 / 5): the ticket quotes the open limits of percolator-prog `feat/v22-rc23-2026-10-22`
 * @ 02524b05, the program the v2.2 app ships with: the κ cap (#594, 253 bps of depth today) and the λ ≤ 1.0 / λ_vol cap (#599) on N_cap,
 * the leverage guard (tag 124, #601 / #605) and the controller math for every record (rc23 quotes a legacy record with it too). All of
 * them only TIGHTEN, so on the pre-rc23 wrapper still deployed on devnet (aca02ba6, which has none of them) the ticket can under-promise
 * room but never over-promise. The guard rules apply only where the program applies them (the market's growth guard bit, or a mainnet
 * build on a clamp-enforced market), so markets without a guard are unchanged by them.
 * Build-time switch `NEXT_PUBLIC_RC23_OPEN_LIMITS=0` quotes the old wrapper exactly (preview builds against aca02ba6 only).
 */
let rc23Override: boolean | null = null;
export function rc23OpenLimits(): boolean {
  return rc23Override ?? process.env.NEXT_PUBLIC_RC23_OPEN_LIMITS?.trim() !== "0";
}
/** Test hook (null = the build switch). */
export function __setRc23OpenLimitsForTest(v: boolean | null): void {
  rc23Override = v;
}


/** The record, or null when growth is OFF / the bytes are not a market account. Never throws. */
export function decodeGrowthRecord(raw: Uint8Array | null | undefined, assetIndex = 0): AssetGrowthV19 | null {
  if (!raw) return null;
  try {
    return decodeAssetGrowthV19(raw, assetIndex);
  } catch {
    return null;
  }
}

/** The market's bankruptcy h-lock is latched (the byte is non-zero; it is not only 0/1 any more). */
export function readBankruptcyHlockActive(raw: Uint8Array | null | undefined): boolean {
  if (!raw) return false;
  const off = hlockOffset(raw);
  if (off === null || raw.length <= off) return false;
  return isBankruptcyHlockActive(raw[off] as number);
}

export interface GrowthMarketInput {
  raw: Uint8Array | null | undefined;
  assetIndex?: number;
  engine: {
    initialMarginBps: bigint;
    /** Guard leverage / short cap (`maintenance_margin_bps`); without it a required guard fails closed. */
    maintenanceMarginBps?: bigint;
    effectivePriceE6: bigint;
    /** The oracle target the guard's price band samples (`lev_target_price`); absent -> the effective price. */
    targetPriceE6?: bigint;
    oiEffLongQ: bigint;
    oiEffShortQ: bigint;
    tradeFeeBaseBps: bigint;
    maxTradingFeeBps: bigint;
  };
  /** The bound vault LP portfolio's money fields; null while unread. */
  lp: { capital: bigint; pnl: bigint; feeCredits: bigint } | null;
  /** The vault LP's ADL-effective signed position (Q); null while unread. */
  lpEffectiveQ: bigint | null;
  /** The market's LP IS the asset's bound vault LP. */
  bound: boolean;
  /**
   * Devnet v2.2: engine `band_bps` and the polled cluster slot (null = unknown). Present, the quote applies the depth tier
   * (lambda_eff, kappa cap), graduation and the stored ratchet; with the slot unknown the CONSERVATIVE reading is used
   * (depth absent: tier 0, lambda 1x, no kappa cap). Absent, the growth-1 quote (flag off).
   *
   * Controller round + continuous leverage (wrapper 21b8ccfd, contlev3): the leverage target is the continuous depth curve (log2-interpolated
   * between the tier anchors) capped by the volatility term and the graded STEPPED stress cap; κ / λ_depth (capacity) read the lagging
   * curve, never looser than the round-2 step. `drawOutstanding` / `modeLong` / `modeShort`
   * pick the stress level and `vol` feeds L_vol ({@link growthControllerInputs} reads them from the market bytes); a record with
   * volatility data and no `vol` fails closed to launch leverage.
   */
  /**
   * v2.2 leverage guard (tag 124): the market's guard account as read this poll (`account` null = absent, undecodable, or for another
   * market / asset), and whether this is a mainnet build (where the program requires a guard on every clamp-enforced growth asset).
   * Omitted = not read (the guard is not quoted).
   */
  guard?: { account: LevGuardV22 | null; mainnet: boolean };
  v22?: {
    bandBps: number;
    nowSlot: bigint | null;
    drawOutstanding?: boolean;
    modeLong?: number;
    modeShort?: number;
    vol?: { liquidationFeeBps: bigint; bandMaxEpochSlots: bigint };
  };
}

/**
 * The controller inputs the v2.2 quote needs, from the market bytes the app already polls: `band_bps` and `band_max_epoch_slots`
 * (band config), `liquidation_fee_bps` (engine config +78, pinned with `offset_of!(V16ConfigAccount, liquidation_fee_bps)` on engine
 * 23f609b3), the engine side modes (real ADL) and the asset's draw record (`outstanding_mirror_atoms` / `pending_moved_atoms`, the
 * draw stress). An unreadable part is left out: no `vol` fails the leverage closed to launch, an unreadable draw record reads as a
 * draw (the more conservative stress). Pure; never throws.
 */
export function growthControllerInputs(
  raw: Uint8Array,
  assetIndex: number,
  engine: { modeLong: number; modeShort: number },
): { bandBps: number; drawOutstanding: boolean; modeLong: number; modeShort: number; vol?: { liquidationFeeBps: bigint; bandMaxEpochSlots: bigint } } {
  const band = readBandRentView(raw, assetIndex);
  let liq: bigint | null = null;
  try {
    liq = parseV17RiskParams(raw, 0n)?.liquidationFeeBps ?? null;
  } catch {
    liq = null;
  }
  let drawOutstanding = true;
  try {
    const d = decodeAssetVaultLpDrawP3(raw, assetIndex);
    drawOutstanding = d === null ? false : d.outstandingMirrorAtoms !== 0n || d.pendingMovedAtoms !== 0n;
  } catch {
    drawOutstanding = true;
  }
  return {
    bandBps: band?.band.bandBps ?? 0,
    drawOutstanding,
    modeLong: engine.modeLong,
    modeShort: engine.modeShort,
    ...(band !== null && liq !== null ? { vol: { liquidationFeeBps: liq, bandMaxEpochSlots: band.band.epochSlots } } : {}),
  };
}

export interface GrowthMarketView {
  record: AssetGrowthV19;
  /**
   * v2.2 flag on, a LEGACY record (flags 0, written by the round-2 wrapper deployed on devnet): the same bytes decoded by the round-2
   * port, whose step-table math the quote, the fee preview and the unlock line use. Null on a controller record (`r3Layout`: the
   * continuous-leverage curve, ./sdk/records/growth-v19) and whenever the v2.2 input is absent (growth-1).
   */
  r2Record: R2.AssetGrowthV19 | null;
  quoteInput: QuoteMaxLeverageInput;
  long: MaxLeverageQuote;
  short: MaxLeverageQuote;
  hlockActive: boolean;
  tradeFeeBaseBps: bigint;
  maxTradingFeeBps: bigint;
  /**
   * The leverage guard's open limits for this market right now (null = the guard was not read, or the v2.2 clock is unknown). Already
   * folded into `long` / `short` (leverage, blocked); its size / short / leverage-at-equity caps are per order (lib/limits/ticket.ts).
   */
  guard: { input: LevGuardOpenInputV22; limits: LevGuardOpenLimitsV22 } | null;
}

/** The ticket's closed reasons beyond the growth gate's own: the guard refuses every open (132 missing, 133 `age_under_6h`). */
export type GuardClosedReason = "guard-new-market" | "guard-missing";

/**
 * The guard's view for this market (`lev_trade_post`'s market part), from the same numbers the growth quote uses (`l_now` = the ceiling
 * in force, `n_now` = N_cap with the rc23 caps). Null when the guard was not read or the clock is unknown.
 */
function guardView(i: GrowthMarketInput, record: AssetGrowthV19, q: MaxLeverageQuote): GrowthMarketView["guard"] {
  if (!i.guard || !i.lp || i.lpEffectiveQ === null || !i.v22 || i.v22.nowSlot === null) return null;
  const clamp = clampEnforced(i.v22.bandBps, record.rGapBps);
  const required = (record.flags & GROWTH_FLAG_LEV_GUARD_V22) !== 0 || (i.guard.mainnet && clamp);
  const input: LevGuardOpenInputV22 = {
    guard: i.guard.account,
    guardRequired: required,
    nowSlot: i.v22.nowSlot,
    lNowX100: q.ceilingX100 > 0 ? q.ceilingX100 : Math.min(record.lLaunchX100, record.lTierX100),
    nCapQ: q.nCapQ ?? 0n,
    priceE6: i.engine.effectivePriceE6,
    targetPriceE6: i.engine.targetPriceE6 && i.engine.targetPriceE6 > 0n ? i.engine.targetPriceE6 : i.engine.effectivePriceE6,
    volHasData: record.volHasData === true,
    volVarX100: record.volVarX100 ?? 0,
    mmrBps: i.engine.maintenanceMarginBps ?? 10_000n,
    engineImrBps: i.engine.initialMarginBps,
    lTierX100: record.lTierX100,
    collateralDecimals: record.collateralDecimals,
    cM: conservativeEquity(i.lp.capital, i.lp.pnl, i.lp.feeCredits),
    oiEffLongQ: i.engine.oiEffLongQ,
    oiEffShortQ: i.engine.oiEffShortQ,
    lpEffQ: i.lpEffectiveQ,
    permProofRequired: i.guard.mainnet,
  };
  return { input, limits: levGuardOpenLimitsV22(input) };
}

/** Fold the guard into a side quote: a blocked market closes both sides; otherwise leverage is `min(quote, L_eff)`. */
function withGuard(q: MaxLeverageQuote, g: GrowthMarketView["guard"]): MaxLeverageQuote {
  if (!g || !g.limits.applies || q.closed) return q;
  if (g.limits.blocked !== null) {
    const reason: GuardClosedReason = g.limits.blocked === "age-under-6h" ? "guard-new-market" : "guard-missing";
    return { ...q, closed: true, closedReason: reason as unknown as MaxLeverageQuote["closedReason"], maxLeverageX100: 0 };
  }
  return q.maxLeverageX100 > g.limits.lEffX100 ? { ...q, maxLeverageX100: g.limits.lEffX100 } : q;
}

/**
 * A LEGACY growth record (flags 0: written by the round-2 wrapper) in the round-2 port's shape, or null for a controller record
 * (`r3Layout`). The only fields the two shapes do not share are the four dead dials at bytes 30..38 (validated 0 on every round-2
 * record and never read by the round-2 math): they are 0 here. Pure.
 */
export function asRound2Record(g: AssetGrowthV19): R2.AssetGrowthV19 | null {
  if (g.r3Layout) return null;
  return { ...g, allocAlphaBps: 0, allocBufferBps: 0, cushionTargetBps: 0, cushionShareBps: 0 };
}

/** The round-2 quote input: the same numbers, the legacy record in the round-2 shape, the band / clock only. */
function r2Input(q: QuoteMaxLeverageInput, r2: R2.AssetGrowthV19): R2.QuoteMaxLeverageInput {
  const { v22, growth: _g, ...rest } = q;
  return { ...rest, growth: r2, ...(v22 ? { v22: { bandBps: v22.bandBps, nowSlot: v22.nowSlot } } : {}) };
}

/** Controller records: the continuous-leverage quote; legacy records under the v2.2 input: the round-2 quote (what that wrapper gates). */
function quoteFor(q: QuoteMaxLeverageInput, r2: R2.AssetGrowthV19 | null, side: "long" | "short"): MaxLeverageQuote {
  // A round-2 quote predates λ_eff on the quote: null keeps the stored λ (only with rc23OpenLimits() off).
  return r2 ? { ...R2.quoteMaxLeverage(r2Input(q, r2), side), lambdaEffBps: null } : quoteMaxLeverage(q, side);
}

/** Null when growth is OFF for this asset or the LP is not read yet (then nothing is claimed). */
export function growthMarketView(i: GrowthMarketInput): GrowthMarketView | null {
  const decoded = decodeGrowthRecord(i.raw, i.assetIndex ?? 0);
  if (!decoded || !i.lp || i.lpEffectiveQ === null) return null;
  // Clock unknown (first paint, before the first slot poll, or an RPC outage): CLAIM NOTHING. The stored depth decays with age (the program's
  // sticky cap is `last_good >> floor(age / 9000)`), so reading it as fresh overquotes the room (about 8x on a market whose keeper is
  // down) and no reading can be called conservative without the slot. The ticket shows no growth numbers until the clock arrives.
  if (i.v22 && i.v22.nowSlot === null) return null;
  const record: AssetGrowthV19 = decoded;
  const rc23Open = rc23OpenLimits();
  const hlockActive = readBankruptcyHlockActive(i.raw);
  const quoteInput: QuoteMaxLeverageInput = {
    engineImrBps: i.engine.initialMarginBps,
    growth: record,
    lpCapital: i.lp.capital,
    lpPnl: i.lp.pnl,
    lpFeeCredits: i.lp.feeCredits,
    lpEffectivePositionQ: i.lpEffectiveQ,
    assetBound: i.bound,
    oiEffLongQ: i.engine.oiEffLongQ,
    oiEffShortQ: i.engine.oiEffShortQ,
    priceE6: i.engine.effectivePriceE6,
    bankruptcyHlockActive: hlockActive,
    ...(i.v22 && i.v22.nowSlot !== null
      ? {
          v22: {
            bandBps: i.v22.bandBps,
            nowSlot: i.v22.nowSlot,
            ...(i.v22.drawOutstanding === undefined ? {} : { drawOutstanding: i.v22.drawOutstanding }),
            ...(i.v22.modeLong === undefined ? {} : { modeLong: i.v22.modeLong }),
            ...(i.v22.modeShort === undefined ? {} : { modeShort: i.v22.modeShort }),
            ...(i.v22.vol === undefined ? {} : { vol: i.v22.vol }),
            rc23Caps: rc23Open,
          },
        }
      : {}),
  };
  // Which wrapper generation wrote the record decides the math (the controller program sets GROWTH_FLAG_R3_LAYOUT from birth). Without
  // the v2.2 input the quote is growth-1 in both ports.
  // rc23 quotes EVERY record with the controller math (a legacy record reads no volatility data), so the round-2 port is used only
  // with rc23OpenLimits() off (the round-2 wrapper still on devnet).
  const r2Record = quoteInput.v22 && !rc23Open ? asRound2Record(record) : null;
  const long = quoteFor(quoteInput, r2Record, "long");
  const short = quoteFor(quoteInput, r2Record, "short");
  const guard = rc23Open ? guardView(i, record, long) : null;
  return {
    record,
    r2Record,
    quoteInput,
    long: withGuard(long, guard),
    short: withGuard(short, guard),
    guard,
    hlockActive,
    tradeFeeBaseBps: i.engine.tradeFeeBaseBps,
    maxTradingFeeBps: i.engine.maxTradingFeeBps,
  };
}

/** The order reduces or closes the taker's position (never blocked or clipped by growth capacity). */
export function isReducingOrder(takerEffQ: bigint, direction: "long" | "short", sizeQ: bigint): boolean {
  if (takerEffQ === 0n || sizeQ <= 0n) return false;
  const signed = direction === "long" ? sizeQ : -sizeQ;
  const after = takerEffQ + signed;
  if (after === 0n) return true;
  return (takerEffQ > 0n) === (after > 0n) && (after < 0n ? -after : after) <= (takerEffQ < 0n ? -takerEffQ : takerEffQ);
}

export interface GrowthFill {
  /** The opening part of the order the program would try to open (Q, unsigned). */
  openingQ: bigint;
  /** Room left on this side: `N_cap - users' OI` (Q); null when growth does not apply (a reduce / close, growth off). */
  roomQ: bigint | null;
  /** The size that will actually fill (Q, unsigned): the closing part plus `min(opening, room)`. Equals `sizeQ` when nothing is trimmed. */
  fillQ: bigint;
  /** The program trims this order to the side's room (it still lands; the fill is smaller than the ask). */
  trimmed: boolean;
}

/**
 * What the wrapper does to an order BEFORE the matcher (`p1_cpi_preflight_before_matcher`): an opening TradeCpi is clipped to
 * `min(ask, N_cap - users' OI on the side, LP headroom)`; a fill may land exactly on N_cap. A reduce / close is never clipped; a
 * flip keeps its closing part and only the opening part is clipped. Pure: `roomQ` is the quote's `headroomQ` (same N_cap and
 * same users' OI the program reads). A closed side has room 0.
 */
export function growthFillForOrder(view: GrowthMarketView, direction: "long" | "short", takerEffQ: bigint, sizeQ: bigint): GrowthFill {
  const quote = direction === "long" ? view.long : view.short;
  const none: GrowthFill = { openingQ: 0n, roomQ: null, fillQ: sizeQ, trimmed: false };
  if (sizeQ <= 0n || !quote.growthOn) return none;
  const signed = direction === "long" ? sizeQ : -sizeQ;
  const openingQ = openingPartQ(takerEffQ, takerEffQ + signed);
  if (openingQ === 0n) return none;
  const roomQ = quote.headroomQ ?? (quote.closed ? 0n : null);
  if (roomQ === null) return { ...none, openingQ };
  const fillOpening = openingQ < roomQ ? openingQ : roomQ;
  return { openingQ, roomQ, fillQ: sizeQ - openingQ + fillOpening, trimmed: fillOpening < openingQ };
}

export interface GrowthTicketDecision {
  /** The side quote the slider cap comes from. */
  quote: MaxLeverageQuote;
  /** Leverage cap for NEW risk (x, 2 dp); `null` = no cap from growth (a reduce, or growth off). */
  maxLeverage: number | null;
  /** New risk on this side is refused now (reduces and closes are never). */
  closed: boolean;
  /** Utilisation of this side, 0..1 (for the capacity bar); null while unknown. */
  utilisation: number | null;
  /** Utilisation fee preview for THIS order (zero for a reduce/close). */
  fee: GrowthOpenFeePreview | null;
  /** The order is a reduce or close: growth does not apply. */
  reducing: boolean;
  /** Room left on this side in Q (N_cap - users' OI, 0 when closed); null when growth does not apply. */
  roomQ: bigint | null;
  /** The size that will actually fill (Q); equals the ask unless the program trims it to the room. */
  fillQ: bigint;
  /** The program trims this order to the room (it lands as a partial fill; it is not refused). */
  trimmed: boolean;
  /** The leverage (x, 2 dp) the program allows at the post-fill users' OI of the size that FILLS; null when it does not apply (no size, reduce, closed). */
  fillMaxLeverage: number | null;
}

export function growthTicketDecision(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): GrowthTicketDecision {
  const d = growthTicketDecisionCore(view, direction, takerEffQ, sizeQ);
  return { ...d, fillMaxLeverage: maxLeverageAtFill(view, d, sizeQ) };
}

function growthTicketDecisionCore(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): Omit<GrowthTicketDecision, "fillMaxLeverage"> {
  const quote = direction === "long" ? view.long : view.short;
  const reducing = isReducingOrder(takerEffQ, direction, sizeQ);
  const utilisation = quote.utilizationBps === null ? null : Math.min(1, Number(quote.utilizationBps) / 10_000);
  const fill = growthFillForOrder(view, direction, takerEffQ, sizeQ);
  // The fee (and the users' OI after) is charged on the size that FILLS, not on the ask.
  const signedFill = direction === "long" ? fill.fillQ : -fill.fillQ;
  const fee = fill.fillQ > 0n
    ? view.r2Record
      ? R2.previewGrowthOpenFee(r2Input(view.quoteInput, view.r2Record), takerEffQ, signedFill, view.tradeFeeBaseBps)
      : previewGrowthOpenFee(view.quoteInput, takerEffQ, signedFill, view.tradeFeeBaseBps)
    : null;
  return {
    quote,
    reducing,
    roomQ: reducing ? null : fill.roomQ ?? (quote.growthOn ? quote.headroomQ : null),
    fillQ: fill.fillQ,
    trimmed: fill.trimmed,
    maxLeverage: reducing || quote.closed ? null : quote.maxLeverageX100 / 100,
    closed: !reducing && quote.closed,
    utilisation,
    fee: reducing ? null : fee,
  };
}

/**
 * The most leverage the program lets THIS order open (Custom 92's own limit), as a plain number (x, 2 dp, rounded DOWN so the
 * figure always passes). The wrapper checks the requirement at the users' open interest AFTER the fill, so on the crowd side this is
 * `floor(1e6 / dynImr(OI_users + opening part, N_cap, base, kink))`, not the current-OI quote (an upper bound); on the thin side it is
 * the launch ceiling. `null` when growth does not apply to the order (a reduce / close, a closed side, an unreadable view) or the
 * fill would push the side past capacity (that is Custom 93, not 92): the caller then says nothing numeric.
 */
export function growthMaxLeverageForOrder(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
): number | null {
  return maxLeverageAtFill(view, growthTicketDecisionCore(view, direction, takerEffQ, sizeQ), sizeQ);
}

function maxLeverageAtFill(view: GrowthMarketView, d: Omit<GrowthTicketDecision, "fillMaxLeverage">, sizeQ: bigint): number | null {
  if (d.reducing || d.closed || sizeQ <= 0n) return null;
  const q = d.quote;
  if (!q.growthOn) return null;
  if (!q.crowd) return q.maxLeverageX100 > 0 ? q.maxLeverageX100 / 100 : null;
  const nCap = q.nCapQ;
  const g = view.record;
  // The ceiling in force (graduation / tiers when the v2.2 rules apply), the same number the gate and the quote use.
  const base = ceilingImrBps(view.quoteInput.engineImrBps, q.ceilingX100 > 0 ? q.ceilingX100 : Math.min(g.lLaunchX100, g.lTierX100));
  const usersAfter = d.fee?.usersOiAfterQ;
  if (nCap === null || base === null || usersAfter === undefined) return null;
  const dyn = dynImrBps(usersAfter, nCap, base, g.kinkBps);
  if (dyn === null) return null;
  const x100 = leverageX100ForImrBps(dyn);
  return x100 === null || x100 <= 0n ? null : Number(x100) / 100;
}

/**
 * The ticket's leverage pre-check (Custom 92's mirror). Returns the max leverage to name when the order is genuinely over-leveraged,
 * else `null`.
 *
 * An order that the program trims to the side's room is judged on what FILLS, never on the ask: the margin the trader set aside for
 * the ask now backs `fillQ` only, so its leverage is `leverage * fillQ / sizeQ`, compared with the leverage the program allows at the
 * post-fill users' OI of that clipped size ({@link growthMaxLeverageForOrder}). An untrimmed order keeps the quote's marginal cap.
 */
export function growthLeverageRefusal(
  view: GrowthMarketView,
  direction: "long" | "short",
  takerEffQ: bigint,
  sizeQ: bigint,
  leverage: number,
): number | null {
  const d = growthTicketDecision(view, direction, takerEffQ, sizeQ);
  if (d.reducing || d.closed || sizeQ <= 0n) return null;
  if (!d.trimmed) return d.maxLeverage !== null && leverage > d.maxLeverage ? d.maxLeverage : null;
  if (d.fillQ <= 0n) return null;
  const allowed = growthMaxLeverageForOrder(view, direction, takerEffQ, sizeQ);
  if (allowed === null) return null;
  const effective = (leverage * Number(d.fillQ)) / Number(sizeQ);
  return effective > allowed ? allowed : null;
}
