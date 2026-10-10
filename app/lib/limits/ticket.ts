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
import { growthTicketDecision, type GrowthMarketView, type GrowthTicketDecision } from "@/lib/v21/growth-market";

export interface TicketIssue {
  kind: "halted" | "same-owner" | "step-down" | "quote-slippage" | "limits-unavailable" | "fee-over-max" | "growth-closed" | "growth-leverage";
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
}

export interface TicketLimits {
  sideLimits: Record<Side, SideLimit> | null;
  halted: Record<Side, boolean>;
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
  sameOwner: false,
  sameOwnerCloseOnly: false,
  clampToQ: null,
  quote: null,
  fee: null,
  growth: null,
  stepDown: null,
  issues: [],
};

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
  const out: TicketLimits = { ...NONE, halted: { long: false, short: false }, issues: [] };
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
        limits: L.riskLimits,
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
  } else if (growth && growth.maxLeverage !== null && i.leverage > growth.maxLeverage) {
    out.issues.push({ kind: "growth-leverage", severity: "error", title: "Leverage adjusted", message: V21_COPY.growthLeverage(String(growth.maxLeverage), i.direction) });
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
