/**
 * Order-ticket decisions for the limits UI, as ONE pure function so the
 * component only renders (plan §2, P1/P2/P3 ticket rows). Everything the
 * ticket disables, clamps or warns about comes from here and is unit-tested.
 */
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { COPY } from "./copy";
import { defaultFeeCapMarginBps, feeChannelOf, signedFeeForQuote, type FeeChannel, type SignedFeeVerdict } from "./fee-channel";
import { VAULT_LP_DEFAULT_MAX_LEV_BPS } from "./constants";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { maxTradeSizePerSide, sameOwnerBlocked, sameOwnerRoomQ, type Side, type SideLimit } from "./risk-limits";
import { preTradeQuote, quoteFailsLimit, type PreTradeQuote } from "./matcher-quote";
import { stepDownMaxLeverage } from "./vault-tranche";
import { V21_COPY } from "@/lib/v21/copy";
import { growthFillCapQ, growthGate, type GrowthGateResult } from "@/lib/v22/growth-gate";
import { V22_COPY } from "@/lib/v22/copy";
import { growthLeverageRefusal, growthTicketDecision, type GrowthMarketView, type GrowthTicketDecision } from "@/lib/v21/growth-market";

export interface TicketIssue {
  kind: "halted" | "same-owner" | "step-down" | "quote-slippage" | "limits-unavailable" | "fee-over-max" | "growth-closed" | "growth-leverage" | "growth-backing";
  severity: "error" | "warning";
  title: string;
  message: string;
}

export interface TicketLimitsInput {
  limits: MarketLimits;
  direction: Side;
  /** |size| the ticket would submit (base q). */
  sizeQ: bigint;
  /** The taker's own signed position on the asset (0 = none). */
  takerPosQ: bigint;
  /** Connected wallet (the taker portfolio owner), or null. */
  takerOwner: Uint8Array | null;
  /** Selected leverage (x). */
  leverage: number;
  /** Worst-fill limit the ticket will sign (e6; 0 = none) — for the P2 quote check. */
  limitPriceE6: bigint;
  /** Mark used for the quote (e6). Defaults to the engine effective price. */
  markE6?: bigint;
  /** Slippage margin on the signed fee cap (bps). Default `defaultFeeCapMarginBps()`. */
  feeMarginBps?: number;
  /**
   * Devnet v2.1: the asset's growth-v19 view (lib/v21/growth-market.ts), or null/undefined when
   * growth is OFF (every market of today's programs). Absent => nothing here changes.
   */
  growth?: GrowthMarketView | null;
  /**
   * The taker's conservative equity on this market (capital + min(pnl,0) + min(fee_credits,0)) before this order, or null/absent when
   * unknown or when the order bundles a deposit sized to itself (first trade). Present, the growth gate of the DEPLOYED wrapper is
   * evaluated on the size that will actually fill (lib/v22/growth-gate.ts) and replaces the slider-based leverage check.
   */
  takerEquity?: bigint | null;
  /** Band market: the program's exact minimum leg in Q (`bandMinLegExactQ`, fractional lots); a fill that would leave a smaller leg is refused (113). */
  minLegQ?: bigint | null;
  /** The smallest add the ticket can place (Q): one whole lot on a lot market, the 4 dp display step otherwise. Below it a side reads full. */
  sizeStepQ?: bigint | null;
  /** Wording helpers for the gate's messages (sizes in the ticket's units, collateral atoms as a dollar string). */
  format?: { size: (q: bigint) => string; collateral: (atoms: bigint) => string };
}

export interface TicketLimits {
  sideLimits: Record<Side, SideLimit> | null;
  halted: Record<Side, boolean>;
  /** Sides paused because they are FULL (growth capacity / room below the minimum or the step): the tab reads "Paused (full)". */
  fullSides: Record<Side, boolean>;
  sameOwner: boolean;
  /** The wallet owns the LP or created the market: it may only reduce/close (P1 item 2). */
  sameOwnerCloseOnly: boolean;
  /** Set when the requested size exceeds the side max: clamp the input to this. */
  clampToQ: bigint | null;
  quote: PreTradeQuote | null;
  /** P2 fee channel for this asset + the fee the ticket must SIGN for this quote. */
  fee: {
    channel: FeeChannel;
    signedFeeBps: bigint;
    requestedBps: bigint;
    /** Slippage margin actually added on top of the quote's fee (after the market-max clamp). */
    marginBps: bigint;
    verdict: SignedFeeVerdict;
    charged: boolean;
    /** Growth N-2: the utilisation fee inside `signedFeeBps` (set only on a growth open that owes one). */
    utilFeeBps?: bigint;
  } | null;
  /** Devnet v2.1 growth decision for this side/size; null when growth is OFF. */
  growth: GrowthTicketDecision | null;
  /** The deployed wrapper's clip + gate for this order (null: growth off, no equity known, or a reduce). */
  growthGate: GrowthGateResult | null;
  /** The most that can be ordered on this side now (clip AND gate); null when growth does not constrain. */
  growthCapQ: bigint | null;
  stepDown: {
    maxLeverage: number;
    stepped: boolean;
    baseMaxLeverage: number;
    crowdBps: number;
    /** UX WP-3 row 8: the cap for THIS size (the ticket lowers the leverage to it). */
    maxLeverageAtSize?: number;
    /** The other side's cap (the inline note names both). */
    otherSideMaxLeverage?: number;
  } | null;
  issues: TicketIssue[];
}

const NONE: TicketLimits = {
  sideLimits: null,
  halted: { long: false, short: false },
  fullSides: { long: false, short: false },
  sameOwner: false,
  sameOwnerCloseOnly: false,
  clampToQ: null,
  quote: null,
  fee: null,
  growth: null,
  growthGate: null,
  growthCapQ: null,
  stepDown: null,
  issues: [],
};

/**
 * Is opening on `side` impossible for this taker right now because of the growth state? A property of the MARKET for a flat taker, so it is
 * evaluated for BOTH sides whatever the ticket's selected direction and whether or not a wallet is connected (otherwise a paused Long is
 * only discovered by selecting it, and the auto-select that moves off it hides it again).
 *  - "closed": the side's growth quote is closed (full / h-lock / not bound ...), unless the holder is on the other side and the tab is a close.
 *  - "min-leg": a band market's room on the side is below the minimum position leg. The program clips an open to the room and then refuses
 *    the leg that is left under `band_min_leg_notional` (Custom 113), so no fill can land. A holder whose leg is already at or above the
 *    minimum may still add; a reduce is never paused.
 */
export function growthSideHalt(
  view: GrowthMarketView | null | undefined,
  side: Side,
  takerPosQ: bigint,
  minLegQ: bigint | null | undefined,
  stepQ?: bigint | null,
): "closed" | "min-leg" | "step" | null {
  if (!view) return null;
  const q = side === "long" ? view.long : view.short;
  if (!q.growthOn) return null;
  const closing = takerPosQ !== 0n && takerPosQ > 0n !== (side === "long") ? (takerPosQ < 0n ? -takerPosQ : takerPosQ) : 0n;
  if (q.closed) return closing > 0n ? null : "closed";
  if (closing > 0n) return null;
  const held = takerPosQ < 0n ? -takerPosQ : takerPosQ;
  const room = q.headroomQ ?? 0n;
  // A FLAT taker's fill is the whole leg: it must reach the program's minimum (band_min_leg_notional, exact notional rule).
  if (held === 0n && minLegQ != null && minLegQ > 0n && room < minLegQ) return "min-leg";
  // Below one size step the ticket cannot place an add at all (an order is whole lots on a lot market; the clip would land a fraction of a
  // lot, which program-wise is allowed but is not a size anyone can ask for). Holders and flat takers alike: the side reads full.
  if (stepQ != null && stepQ > 0n && room < stepQ) return "step";
  return null;
}

export function deriveTicketLimits(i: TicketLimitsInput): TicketLimits {
  const L = i.limits;
  if (L.state === "off" || !L.engine) {
    // The wrapper refuses an opening trade from the market's creator / LP owner (SameOwnerTrade,
    // Custom 67) on EVERY build, limits flags or not. Without this the creator got a normal
    // ticket, signed, and the trade leg was refused on-chain ("Something went wrong").
    if (!sameOwnerBlocked(i.takerOwner, L.lp?.owner ?? L.sameOwnerLpOwner ?? null, L.assetAdmin)) return NONE;
    const sameOwner = sameOwnerRoomQ(i.takerPosQ, i.direction) === 0n;
    return {
      ...NONE,
      halted: { long: false, short: false },
      sameOwnerCloseOnly: true,
      sameOwner,
      issues: sameOwner ? [{ kind: "same-owner", severity: "error", title: "Can't open from this wallet", message: COPY.sameOwner }] : [],
    };
  }
  const out: TicketLimits = { ...NONE, halted: { long: false, short: false }, fullSides: { long: false, short: false }, issues: [] };
  const e = L.engine;

  // ── P1 ────────────────────────────────────────────────────────────────
  if (L.flags.p1) {
    if (L.state === "error" && !L.riskLimits) {
      out.issues.push({ kind: "limits-unavailable", severity: "warning", title: "Limits unavailable", message: COPY.limitsUnavailable });
    }
    if (L.riskLimits) {
      out.sideLimits = maxTradeSizePerSide({
        priceE6: e.effectivePriceE6,
        initialMarginBps: e.initialMarginBps,
        oiEffLongQ: e.oiEffLongQ,
        oiEffShortQ: e.oiEffShortQ,
        // On a growth asset the program's LP exposure multiplier defaults to the growth lambda, not 1e8/IMR (lp_floor_and_cap_q_for_target_view:
        // `(0, Some(g)) => g.lambda_bps`); an explicit stored value stays an override. Without this the ticket's "most available" and
        // the program's clip were two different numbers (QA LEV-8: 7.65 vs 5.94 lots).
        limits: i.growth && L.riskLimits.lpExposureKBps === 0 ? { ...L.riskLimits, lpExposureKBps: i.growth.record.lambdaBps } : L.riskLimits,
        lp: L.lp,
        takerPosQ: i.takerPosQ,
        matcher: L.matcher
          ? { maxFillAbs: L.matcher.maxFillAbs, maxInventoryAbs: L.matcher.maxInventoryAbs, inventoryBase: L.matcher.inventoryBase, lpRealQ: L.lpRealQ ?? null, syncLive: L.matcherSyncLive === true }
          : null,
        vaultLp: boundVaultLpCap(L),
      });
      // P1 item 2 (2e7f87de): the LP owner / creator may still CLOSE — cap each side at the
      // taker's reducing room instead of blocking the whole ticket.
      if (sameOwnerBlocked(i.takerOwner, L.lp?.owner ?? L.sameOwnerLpOwner ?? null, L.assetAdmin)) {
        out.sameOwnerCloseOnly = true;
        for (const side of ["long", "short"] as const) {
          const room = sameOwnerRoomQ(i.takerPosQ, side);
          if (room < out.sideLimits[side].maxQ) out.sideLimits[side] = { maxQ: room, reason: "same-owner", halted: out.sideLimits[side].halted };
        }
      }
      out.halted = { long: out.sideLimits.long.halted, short: out.sideLimits.short.halted };
      const lim = out.sideLimits[i.direction];
      if (lim.halted) {
        out.issues.push({ kind: "halted", severity: "error", title: "Opening paused", message: COPY.halted(i.direction) });
      } else if (i.sizeQ > 0n && lim.maxQ > 0n && lim.maxQ !== UNLIMITED_CAPACITY && i.sizeQ > lim.maxQ) {
        out.clampToQ = lim.maxQ;
      }
    }
    // Blocked only when this ticket's direction cannot reduce the taker (room 0).
    out.sameOwner = out.sameOwnerCloseOnly && sameOwnerRoomQ(i.takerPosQ, i.direction) === 0n;
    if (out.sameOwner) out.issues.push({ kind: "same-owner", severity: "error", title: "Can't open from this wallet", message: COPY.sameOwner });
  }

  // ── Devnet v2.1: growth-v19 dynamic leverage (feature-detected; absent on today's programs) ──
  const growth = i.growth ? growthTicketDecision(i.growth, i.direction, i.takerPosQ, i.sizeQ) : null;
  out.growth = growth;
  // Closes are never blocked (growth M-1): a holder of the opposite side may be about to reduce, so
  // an empty ticket (no size yet) is not "paused" for them.
  const mayReduce = i.takerPosQ !== 0n && (i.takerPosQ > 0n) !== (i.direction === "long");
  const growthBlocks = !!growth?.closed && !(mayReduce && i.sizeQ === 0n);
  if (growth && growthBlocks) {
    out.halted[i.direction] = true;
    out.issues.push({ kind: "growth-closed", severity: "error", title: "This side is full", message: V21_COPY.growthClosed(i.direction, growth.quote.closedReason) });
  } else if (growth && i.growth && i.takerEquity == null) {
    // LEV-8: judged on the size that will FILL (the program trims an over-capacity open to the side's room and lands it), never on the ask.
    const over = growthLeverageRefusal(i.growth, i.direction, i.takerPosQ, i.sizeQ, i.leverage);
    if (over !== null) {
      out.issues.push({ kind: "growth-leverage", severity: "error", title: "Leverage adjusted", message: V21_COPY.growthLeverage(String(over), i.direction) });
    }
  }
  const utilFeeBps = growth?.fee ? BigInt(growth.fee.utilFeeBps) : 0n;

  // ── P2 quote ─────────────────────────────────────────────────────────────
  if (L.flags.p2 && L.matcher && i.sizeQ > 0n) {
    // The wrapper hands the matcher the engine's effective_price (not the UI's live tick).
    const mark = e.effectivePriceE6;
    const lim = out.sideLimits?.[i.direction];
    // Post-upgrade the matcher prices / clips from the LP's real position, not its stored counter.
    const quoteCtx =
      L.matcherSyncLive === true && L.lpRealQ != null ? { ...L.matcher, inventoryBase: L.lpRealQ } : L.matcher;
    out.quote = preTradeQuote(quoteCtx, mark, out.clampToQ ?? i.sizeQ, i.direction === "long", {
      bandBps: L.bandBps ?? undefined,
      headroomQ: lim && lim.maxQ !== UNLIMITED_CAPACITY ? lim.maxQ : undefined,
    });
    if (out.quote && quoteFailsLimit(out.quote.quotePriceE6, i.limitPriceE6, i.direction === "long")) {
      out.issues.push({ kind: "quote-slippage", severity: "warning", title: "Slippage limit too tight", message: COPY.quoteSlippage("your limit") });
    }
    // P2 fee channel (P1 e74809b1): the quote is CHARGED when the protocol enabled it for the asset.
    const channel = feeChannelOf(L.riskLimits);
    if (out.quote) {
      const f = signedFeeForQuote(
        e.tradeFeeBaseBps,
        out.quote.quotePriceE6,
        mark,
        channel,
        e.maxTradingFeeBps,
        out.quote.kind === "legacy" ? out.quote.maxTotalBps : undefined,
        i.feeMarginBps ?? defaultFeeCapMarginBps(),
        utilFeeBps,
      );
      out.fee = { channel, ...f, charged: channel.enabled || L.flags.p2FeeCharged, ...(utilFeeBps > 0n ? { utilFeeBps } : {}) };
      if (f.verdict !== "ok") {
        out.issues.push({
          kind: "fee-over-max",
          severity: "error",
          title: "Quote fee over the limit",
          message: f.verdict === "over-protocol-max" ? COPY.feeOverProtocolMax(`${(Number(channel.protocolMaxBps) / 100).toFixed(2)}%`) : COPY.feeOverMarketMax,
        });
      }
    }
  }

  // ── Devnet v2.2: the deployed wrapper's clip + growth gate on the size that FILLS (QA LEV-8) ──────────────
  if (i.growth && !growth?.reducing) {
    const params = {
      view: i.growth,
      direction: i.direction,
      takerEffQ: i.takerPosQ,
      takerEquity: i.takerEquity ?? 0n,
      quoteFeeBps: out.fee?.requestedBps ?? 0n,
    };
    if (i.takerEquity != null) {
      out.growthCapQ = growthFillCapQ(params);
      if (i.sizeQ > 0n && !growth?.closed) {
        const gate = growthGate({ ...params, askQ: i.sizeQ });
        out.growthGate = gate;
        const fmt = i.format;
        if (!gate.passes && !gate.closed && fmt) {
          out.issues.push({
            kind: "growth-backing",
            severity: "error",
            title: "More collateral needed",
            message: gate.maxPassingQ > 0n
              ? V22_COPY.growth.backingTrim(fmt.size(gate.maxPassingQ), fmt.collateral(gate.extraEquityNeeded), fmt.size(gate.clipQ))
              : V22_COPY.growth.backingAdd(fmt.collateral(gate.extraEquityNeeded)),
          });
        }
      }
    }
    // Band market: the room left on a side can be smaller than the minimum position (see growthSideHalt).
    const own = growth && !growth.reducing ? growthSideHalt(i.growth, i.direction, i.takerPosQ, i.minLegQ, i.sizeStepQ) : null;
    if (own === "min-leg" || own === "step") {
      out.halted[i.direction] = true;
      out.fullSides[i.direction] = true;
      out.issues.push({ kind: "growth-closed", severity: "error", title: "This side is full", message: V21_COPY.growthClosed(i.direction, "capacity-full") });
    }
  }
  // The OTHER side's tab: paused for the same market reasons, independent of the wallet and of the selected direction.
  const other: Side = i.direction === "long" ? "short" : "long";
  const otherHalt = growthSideHalt(i.growth, other, i.takerPosQ, i.minLegQ, i.sizeStepQ);
  if (otherHalt !== null) {
    out.halted[other] = true;
    out.fullSides[other] = true;
  }
  if (growth?.closed && !growth.reducing) out.fullSides[i.direction] = true;

  // ── P3 leverage step-down ──────────────────────────────────────────────────
  if (L.flags.p3 && L.vaultLp?.bound && L.vaultLp.levCapQ > 0n) {
    const probe = stepDownMaxLeverage(L.vaultLp.lpNetQ, 1n, i.direction === "long", L.vaultLp.levCapQ, e.initialMarginBps, L.vaultLp.levMaxImrBps);
    const atSize = i.sizeQ > 0n
      ? stepDownMaxLeverage(L.vaultLp.lpNetQ, i.sizeQ, i.direction === "long", L.vaultLp.levCapQ, e.initialMarginBps, L.vaultLp.levMaxImrBps)
      : probe;
    const base = e.initialMarginBps > 0n ? Number(10_000n / e.initialMarginBps) : 1;
    const absNet = L.vaultLp.lpNetQ < 0n ? -L.vaultLp.lpNetQ : L.vaultLp.lpNetQ;
    const crowdBps = Number((absNet * 10_000n) / L.vaultLp.levCapQ);
    const otherProbe = stepDownMaxLeverage(L.vaultLp.lpNetQ, 1n, i.direction !== "long", L.vaultLp.levCapQ, e.initialMarginBps, L.vaultLp.levMaxImrBps);
    out.stepDown = {
      maxLeverage: probe.maxLeverage,
      stepped: probe.stepped,
      baseMaxLeverage: base,
      crowdBps: Math.min(crowdBps, 10_000),
      maxLeverageAtSize: atSize.stepped ? atSize.maxLeverage : undefined,
      otherSideMaxLeverage: otherProbe.stepped ? otherProbe.maxLeverage : base,
    };
    if (atSize.stepped && i.leverage > atSize.maxLeverage) {
      out.issues.push({
        kind: "step-down",
        severity: "error",
        title: "Leverage too high for this side",
        message: COPY.stepDown(String(atSize.maxLeverage), i.direction, `${(Math.min(crowdBps, 10_000) / 100).toFixed(0)}%`, String(base)),
      });
    }
  }
  return out;
}

/**
 * P3-H2 vault-LP exposure cap, when the market's LP is the asset's bound vault LP
 * (flag P3). `vault_lp_max_lev_bps` 0 => the protocol default 1x.
 */
export function boundVaultLpCap(L: MarketLimits): { levBps: number } | null {
  if (!L.flags.p3 || !L.vaultLp?.bound || !L.lp) return null;
  const key = L.lp.address.toBytes();
  const same = key.length === L.vaultLp.vaultLpPortfolio.length && key.every((b, k) => b === L.vaultLp!.vaultLpPortfolio[k]);
  if (!same) return null;
  return { levBps: L.vaultLp.vaultLpMaxLevBps === 0 ? VAULT_LP_DEFAULT_MAX_LEV_BPS : L.vaultLp.vaultLpMaxLevBps };
}

/** base-q -> the ticket's size-input string (token units = q / 1e6, or USD at `priceE6`). */
export function sizeQToInput(q: bigint, unit: "token" | "usd", priceE6: bigint, lotExp = 0): string {
  if (unit === "token") {
    // v2.2 lot markets: q is in LOTS; the box is in TOKENS (lib/v22/lot.ts). lotExp 0 is the identity.
    if (lotExp > 0) q = q * 10n ** BigInt(lotExp);
    const whole = q / 1_000_000n;
    const frac = (q % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : `${whole}`;
  }
  // USD atoms (6 dp) floored to cents so the clamped size never exceeds the max.
  const usdAtoms = (q * priceE6) / 1_000_000n;
  const cents = usdAtoms / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * P1 99165722 (F-7): the LP's halt / cap applies to a CLOSE that grows the LP too. Closing a
 * long sells ("short" side), closing a short buys ("long"). Returns the notice the Close tab
 * must show, or null when the whole position can close.
 */
export type CloseLimitNotice = { kind: "halted" } | { kind: "capped"; maxQ: bigint } | null;
export function closeLimitNotice(positionQ: bigint, sideLimits: Record<Side, SideLimit> | null): CloseLimitNotice {
  if (!sideLimits || positionQ === 0n) return null;
  const lim = sideLimits[positionQ > 0n ? "short" : "long"];
  const size = positionQ < 0n ? -positionQ : positionQ;
  if (lim.halted || (lim.reason === "lp-halt" && lim.maxQ === 0n)) return { kind: "halted" };
  if ((lim.reason === "lp-halt" || lim.reason === "lp-exposure") && lim.maxQ < size) return { kind: "capped", maxQ: lim.maxQ };
  return null;
}

/**
 * UX WP-3 (§3.3 row 11): the largest size at or under `i.sizeQ` whose P2 quote fee fits the
 * market's maximum, by bisection over the same pure derivation. null = none fits (or no issue).
 */
export function feeFitSizeQ(i: TicketLimitsInput, steps = 64): bigint | null {
  const over = (q: bigint) => deriveTicketLimits({ ...i, sizeQ: q }).issues.some((x) => x.kind === "fee-over-max");
  if (i.sizeQ <= 0n || !over(i.sizeQ)) return null;
  let lo = 0n;
  let hi = i.sizeQ;
  for (let k = 0; k < steps && hi - lo > 1n; k++) {
    const mid = (lo + hi) / 2n;
    if (over(mid)) hi = mid;
    else lo = mid;
  }
  return lo > 0n && !over(lo) ? lo : null;
}
