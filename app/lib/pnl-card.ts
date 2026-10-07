/**
 * Pure data model for the live PnL share card (components/share/PnlShareCard +
 * PnlShareModal). Kept framework-free so the math is unit-testable and so the
 * card and the Share-to-X text can never disagree with each other.
 *
 * PnL / ROE reuse the SAME engine-formula helpers the trade page's PositionsDock
 * and ChartPnlBadge use (lib/trading), so the card matches the position row to
 * the cent. sim-USDC collateral is $1-pegged (PLAYGROUND.md), so a collateral-
 * scale atom count divided by 10^decimals IS the USD figure.
 */
import { tokenUsdOfLotUsd } from "@/lib/v22/lot";
import { computePnlPercent } from "@percolatorct/sdk";
import { computePositionInitialMargin } from "@/lib/trading";
import { valueAtMark } from "@/lib/position-pnl";

function valueRoe(pnlCollateral: bigint, marginSizeQ: bigint, entryE6: bigint, initialMarginBps: bigint): number {
  try {
    const margin = computePositionInitialMargin(marginSizeQ, entryE6, initialMarginBps);
    const roe = margin > 0n ? computePnlPercent(pnlCollateral, margin) : 0;
    return Number.isFinite(roe) ? roe : 0;
  } catch {
    return 0;
  }
}

/** Everything the card needs that is STATIC for the life of the modal. */
export interface PnlCardData {
  slab: string;
  /** Ticker, already stripped of any "-PERP" suffix. */
  symbol: string;
  /** Full market name. */
  name: string;
  /** The market's uploaded logo (`markets_with_stats.logo_url`). Wins when set. */
  logoUrl: string | null;
  /**
   * Mainnet contract address of the underlying (`markets_with_stats.mainnet_ca`).
   * When there is no logoUrl the modal resolves a DEX logo from it, exactly like
   * components/market/MarketLogo.tsx. Deliberately NOT the market's `mint_address`:
   * on the playground that is usually the devnet mint, which the mainnet-only
   * /api/token-logo lookup can't resolve.
   */
  mainnetCa?: string | null;
  /** Collateral decimals (sim-USDC = 6). */
  decimals: number;
  /** Nominal basis `account.positionSize` (display of the ADL reduction only). */
  nominalSizeQ: bigint;
  /** ADL-effective size — PnL moves on this (lib/v17-adl). Equals nominal when never deleveraged. */
  effectiveSizeQ: bigint;
  /** Entry price (E6; per LOT on a v2.2 lot market). */
  entryE6: bigint;
  /** v2.2 lot exponent of the market (0 / omitted = no lots). The card SHOWS per-token prices (lib/v22/lot.ts). */
  lotExp?: number;
  /** Initial-margin bps for this market. */
  initialMarginBps: bigint;
  /** Mark to use until the live store publishes a tick (keeps the card non-blank). */
  initialMarkE6: bigint;
  /**
   * What the market's vault + insurance can currently pay out, in collateral atoms
   * (PositionsDock's `payableCapacity`). When the paper PnL exceeds it the card
   * shows the payable figure instead, flagged as capped — the same rule as the
   * dock's pool-cap caveat (isPnlPoolCapped). null/undefined = unknown, no cap.
   */
  payableCapacityAtoms?: bigint | null;
}

/** Sign of the PnL the card shows. Drives PROFIT/LOSS/BREAKEVEN, wording, arrow and colour. */
export type PnlTone = "profit" | "loss" | "flat";

/**
 * Pool-capped PnL (GMX-style): a winning position's paper PnL can't exceed what
 * the vault + insurance can pay. Shared by PositionsDock's caveat icon and the
 * share card so the two can never disagree about when a PnL is capped.
 */
export function isPnlPoolCapped(pnlAtoms: bigint, payableCapacityAtoms: bigint | null | undefined): boolean {
  return payableCapacityAtoms != null && pnlAtoms > 0n && payableCapacityAtoms > 0n && pnlAtoms > payableCapacityAtoms;
}

/** Vault + insurance payout capacity, in collateral atoms (PositionsDock's formula). */
export function poolPayableCapacity(vault: bigint | null | undefined, insurance: bigint | null | undefined): bigint {
  return (vault ?? 0n) + (insurance ?? 0n);
}

export interface PnlCardStats {
  /** Live mark used (E6). */
  markE6: bigint;
  /** Unrealized PnL in USD the card shows (sign carried) — the payable figure when capped. */
  pnlUsd: number;
  /** Return on committed margin, percent (sign carried), on the shown pnlUsd. */
  roePct: number;
  /** The uncapped paper PnL, USD. Equals pnlUsd unless isCapped. */
  paperPnlUsd: number;
  /** The paper PnL exceeds the pool's payable capacity; pnlUsd is the capped figure. */
  isCapped: boolean;
  /** Sign of the shown PnL (exact, at collateral-atom resolution — the dock's colour rule). */
  tone: PnlTone;
  /** Collateral committed to this position, USD. */
  spentUsd: number;
  /** Entry price, USD. */
  avgEntryUsd: number;
  /** Current mark (the price you'd exit at right now), USD. */
  avgExitUsd: number;
  /** pnlUsd >= 0 — background-set selection only; text/colour use `tone`. */
  isProfit: boolean;
  /** True once a real mark is available (markE6 > 0). */
  hasMark: boolean;
}

const e6ToUsd = (e6: bigint): number => Number(e6) / 1_000_000;

/** Compute the card's live figures for a given mark. Never throws. */
export function computePnlCardStats(data: PnlCardData, markRawE6: bigint): PnlCardStats {
  const markE6 = markRawE6 > 0n ? markRawE6 : data.initialMarkE6;
  const div = 10 ** data.decimals;
  const hasMark = markE6 > 0n;

  let pnlUsd = 0;
  let roePct = 0;
  let paperPnlUsd = 0;
  let isCapped = false;
  let tone: PnlTone = "flat";
  if (hasMark && data.entryE6 > 0n) {
    // The shared mark-to-market core (lib/position-pnl.ts), so this card cannot
    // drift from the bar / badge / dock / portfolio card.
    const valued = valueAtMark({
      effectiveSize: data.effectiveSizeQ,
      entryE6: data.entryE6,
      markE6,
      initialMarginBps: data.initialMarginBps,
      capital: 0n,
    });
    const paperCollateral = valued.unrealizedPnl;
    isCapped = isPnlPoolCapped(paperCollateral, data.payableCapacityAtoms);
    const pnlCollateral = isCapped ? (data.payableCapacityAtoms as bigint) : paperCollateral;
    const toUsd = (atoms: bigint) => {
      const v = Number(atoms) / div;
      return Number.isFinite(v) ? v : 0;
    };
    pnlUsd = toUsd(pnlCollateral);
    paperPnlUsd = toUsd(paperCollateral);
    tone = pnlCollateral > 0n ? "profit" : pnlCollateral < 0n ? "loss" : "flat";
    // ROE is on the SHOWN pnl (the payable cap can shrink it), same margin base.
    roePct = isCapped
      ? valueRoe(pnlCollateral, data.effectiveSizeQ, data.entryE6, data.initialMarginBps)
      : valued.roe;
  }

  const spentRaw =
    data.entryE6 > 0n
      ? Number(computePositionInitialMargin(data.effectiveSizeQ, data.entryE6, data.initialMarginBps)) / div
      : 0;

  return {
    markE6,
    pnlUsd,
    roePct,
    paperPnlUsd,
    isCapped,
    tone,
    spentUsd: Number.isFinite(spentRaw) ? spentRaw : 0,
    avgEntryUsd: tokenUsdOfLotUsd(e6ToUsd(data.entryE6), data.lotExp ?? 0),
    avgExitUsd: tokenUsdOfLotUsd(e6ToUsd(markE6), data.lotExp ?? 0),
    isProfit: pnlUsd >= 0,
    hasMark,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** `+$378.96` / `-$12.40` — signed; `$` after the sign. Exactly zero is `$0.00`. */
export function formatSignedUsd(n: number): string {
  if (n === 0) return "$0.00";
  const sign = n < 0 ? "-" : "+";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `+42.8%` / `-9.1%`. Exactly zero is `0.0%`. */
export function formatSignedPct(n: number): string {
  if (n === 0) return "0.0%";
  const sign = n < 0 ? "-" : "+";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}

/**
 * A market price can be anything from thousands of dollars to a tiny-fraction
 * memecoin, so pick the precision from the magnitude (never scientific notation).
 */
export function formatPriceUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n >= 1000) return `$${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}K`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // Sub-cent: up to 8 dp, trimmed.
  return `$${n.toFixed(8).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

// ── Share-to-X ────────────────────────────────────────────────────────────────

export const PERCOLATOR_TAG = "Percolator Trade · Devnet V2";

/** The card's headline words for a tone. The card and the tweet both read from `stats.tone`. */
export function pnlCardWording(tone: PnlTone): { label: string; headline: string; arrow: string } {
  if (tone === "profit") return { label: "PROFIT", headline: "YOU'VE MADE", arrow: "▲" };
  if (tone === "loss") return { label: "LOSS", headline: "YOU'RE DOWN", arrow: "▼" };
  return { label: "BREAKEVEN", headline: "YOU'RE AT", arrow: "" };
}

/** The small note under a pool-capped PnL. Same wording on the card and in the tweet. */
export const PNL_CAPPED_NOTE = "capped at what the pool can pay";

/**
 * The prebuilt tweet body. Plain and factual — the same amount, percent and sign
 * the card shows (one `stats` object feeds both), no emoji, and "Devnet V2" plus
 * "sim-USDC" so nobody reads it as real money. The market URL is added via the
 * intent's `url`.
 */
export function buildShareTweet(data: PnlCardData, stats: PnlCardStats): string {
  const amount = formatSignedUsd(stats.pnlUsd).replace(/^[+-]/, "");
  const pct = formatSignedPct(stats.roePct);
  const ticker = data.symbol ? `$${data.symbol}` : "this market";
  const capped = stats.isCapped ? `, ${PNL_CAPPED_NOTE}` : "";
  const lead =
    stats.tone === "profit" ? `I'm up ${amount} (${pct}${capped})`
    : stats.tone === "loss" ? `I'm down ${amount} (${pct})`
    : `I'm at breakeven (${amount}, ${pct})`;
  return `${lead} on ${ticker} on Percolator Trade Devnet V2 (sim-USDC, test funds)`;
}

/** Full twitter/x intent URL: prebuilt text + link to the market. */
export function buildShareToXUrl(data: PnlCardData, stats: PnlCardStats, origin: string): string {
  const text = buildShareTweet(data, stats);
  const url = `${origin}/trade/${data.slab}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

/**
 * Background scenes live in public/pnl-cards/. The card falls back to a gradient
 * per slot. The two sets are tone-matched to the result — the celebratory art
 * only shows on a profit; a loss gets its own, so the card never reads
 * "I made money" over a red PnL.
 */
export const PNL_CARD_BACKGROUNDS_PROFIT: readonly string[] = [
  "/pnl-cards/bg-1.png",
  "/pnl-cards/bg-2.png",
  "/pnl-cards/bg-3.png",
  "/pnl-cards/bg-4.png",
  "/pnl-cards/bg-5.png",
];

export const PNL_CARD_BACKGROUNDS_LOSS: readonly string[] = [
  "/pnl-cards/negpnl-1.jpg",
  "/pnl-cards/negpnl-2.jpg",
  "/pnl-cards/negpnl-3.jpg",
];

/** The background set for the given result. */
export function pnlCardBackgrounds(isProfit: boolean): readonly string[] {
  return isProfit ? PNL_CARD_BACKGROUNDS_PROFIT : PNL_CARD_BACKGROUNDS_LOSS;
}
