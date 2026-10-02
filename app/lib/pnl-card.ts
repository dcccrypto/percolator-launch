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
import {
  computeMarkPnl,
  computeMarkPnlCollateral,
  computePnlPercent,
  computePositionInitialMargin,
} from "@/lib/trading";

/** Everything the card needs that is STATIC for the life of the modal. */
export interface PnlCardData {
  slab: string;
  /** Ticker, already stripped of any "-PERP" suffix. */
  symbol: string;
  /** Full market name. */
  name: string;
  /** Resolved logo URL, if the caller already has one. */
  logoUrl: string | null;
  /** Token mint — the modal resolves a logo via /api/token-logo/{mint} when logoUrl is null. */
  mintAddress?: string | null;
  /** Collateral decimals (sim-USDC = 6). */
  decimals: number;
  /** Nominal basis `account.positionSize` — margin ("spent") is priced on this. */
  nominalSizeQ: bigint;
  /** ADL-effective size — PnL moves on this (lib/v17-adl). Equals nominal when never deleveraged. */
  effectiveSizeQ: bigint;
  /** Entry price (E6). */
  entryE6: bigint;
  /** Initial-margin bps for this market. */
  initialMarginBps: bigint;
  /** Mark to use until the live store publishes a tick (keeps the card non-blank). */
  initialMarkE6: bigint;
}

export interface PnlCardStats {
  /** Live mark used (E6). */
  markE6: bigint;
  /** Unrealized PnL in USD (sign carried). */
  pnlUsd: number;
  /** Return on committed margin, percent (sign carried). */
  roePct: number;
  /** Collateral committed to this position, USD. */
  spentUsd: number;
  /** Entry price, USD. */
  avgEntryUsd: number;
  /** Current mark (the price you'd exit at right now), USD. */
  avgExitUsd: number;
  /** pnlUsd >= 0. */
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
  if (hasMark && data.entryE6 > 0n) {
    const pnlNative = computeMarkPnl(data.effectiveSizeQ, data.entryE6, markE6);
    const pnlCollateral = computeMarkPnlCollateral(pnlNative, markE6);
    const raw = Number(pnlCollateral) / div;
    pnlUsd = Number.isFinite(raw) ? raw : 0;
    const margin = computePositionInitialMargin(data.nominalSizeQ, data.entryE6, data.initialMarginBps);
    try {
      roePct = margin > 0n ? computePnlPercent(pnlCollateral, margin) : 0;
    } catch {
      roePct = 0;
    }
    if (!Number.isFinite(roePct)) roePct = 0;
  }

  const spentRaw =
    data.entryE6 > 0n
      ? Number(computePositionInitialMargin(data.nominalSizeQ, data.entryE6, data.initialMarginBps)) / div
      : 0;

  return {
    markE6,
    pnlUsd,
    roePct,
    spentUsd: Number.isFinite(spentRaw) ? spentRaw : 0,
    avgEntryUsd: e6ToUsd(data.entryE6),
    avgExitUsd: e6ToUsd(markE6),
    isProfit: pnlUsd >= 0,
    hasMark,
  };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** `+$378.96` / `-$12.40` — always signed; `$` after the sign. */
export function formatSignedUsd(n: number): string {
  const sign = n < 0 ? "-" : "+";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `+42.8%` / `-9.1%`. */
export function formatSignedPct(n: number): string {
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

/** The prebuilt tweet body ("I'm up/down $X …"). The market URL is added via the intent's `url`. */
export function buildShareTweet(data: PnlCardData, stats: PnlCardStats): string {
  const dir = stats.pnlUsd >= 0 ? "up" : "down";
  const amount = `$${Math.abs(stats.pnlUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = formatSignedPct(stats.roePct);
  const ticker = data.symbol ? `$${data.symbol}` : "this market";
  return `I'm ${dir} ${amount} (${pct}) on ${ticker} on Percolator Trade Devnet V2 🚀`;
}

/** Full twitter/x intent URL: prebuilt text + link to the market. */
export function buildShareToXUrl(data: PnlCardData, stats: PnlCardStats, origin: string): string {
  const text = buildShareTweet(data, stats);
  const url = `${origin}/trade/${data.slab}`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

/** Background scenes live in public/pnl-cards/. The card falls back to a gradient per slot. */
export const PNL_CARD_BACKGROUNDS: readonly string[] = [
  "/pnl-cards/bg-1.png",
  "/pnl-cards/bg-2.png",
  "/pnl-cards/bg-3.png",
  "/pnl-cards/bg-4.png",
  "/pnl-cards/bg-5.png",
];
