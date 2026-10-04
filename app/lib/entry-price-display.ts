/**
 * The ONE way an entry price reaches a trader's screen (#2660).
 *
 * v17/v18 portfolios carry NO entry price on-chain: a leg is
 * `basis_pos_q / a_basis / k_snap / f_snap / …` (engine `PortfolioLegV16`,
 * percolator 35ddd692) and `k_snap` is rewritten at every settlement, so the
 * open price is not recoverable from chain state. `account.entryPrice` is
 * therefore structurally `0n` on every real account (lib/userAccountScan.ts,
 * hooks/usePortfolio.ts). The entry is reconstructed by `resolveEntryPrice`
 * (lib/trading.ts) and travels with a `source`:
 *
 *   "server"  — the indexer's authoritative open price (indexer#211): the real entry.
 *   "cache"   — saved at open by OrderTicket on this device: the real entry.
 *   "derived" — back-solved from the portfolio's on-chain `pnl`: an estimate.
 *   "unknown" — neither; `.entry` is the MARK (so risk math keeps a sane
 *               denominator) and must never be displayed as an entry, nor
 *               used for a displayed PnL (it makes PnL ≈ 0 / mark drift).
 *
 * Surfaces that read `account.entryPrice` rendered "—" for every position;
 * surfaces that read `.entry` without its source rendered the mark as the
 * entry. Both route through here now.
 */

import { formatUsdPriceE6 } from "@/lib/format";
import { UNKNOWN_ENTRY_TOOLTIP, type EntryPriceSource } from "@/lib/trading";

export const DERIVED_ENTRY_TOOLTIP =
  "Estimated from this position's on-chain PnL — no entry price was saved on this device. " +
  "Percolator doesn't store entry price on-chain, so PnL and ROE here are approximate.";

/** The entry is a real recorded open price (not a back-solved estimate). */
export function isExactEntrySource(source: EntryPriceSource | null | undefined): boolean {
  return source === "server" || source === "cache";
}

/** Calm suffix for any figure computed from a back-solved entry. */
export const ESTIMATE_LABEL = "est.";

/**
 * True when `entryE6` is a real (cached or PnL-derived) entry, not the mark placeholder.
 *
 * An ALLOWLIST, not `source !== "unknown"` (#2671, @0x-SquidSol): the denylist
 * fails open — a missing/undefined source (a fixture, mock data, a JS caller)
 * or a member added later would print the mark as the entry. Test fixtures
 * using the non-member "onchain" sailed straight through it.
 */
export function isEntryKnown(
  entryE6: bigint | null | undefined,
  source: EntryPriceSource | null | undefined,
): boolean {
  const trusted = source === "server" || source === "cache" || source === "derived";
  return trusted && entryE6 != null && entryE6 > 0n;
}

/**
 * Entry for DISPLAY and for DISPLAYED PnL: the resolved entry, or `0n` when it
 * is unknown. Every consumer already treats `entry <= 0n` as "no entry"
 * (formatUsdPriceE6 → "—", computeLivePositionPnl → polled fallback,
 * ClosePositionModal → no PnL). Risk math (liq price, locked margin) keeps
 * using the raw resolved `.entry`.
 */
export function displayEntryE6(
  entryE6: bigint | null | undefined,
  source: EntryPriceSource | null | undefined,
): bigint {
  return isEntryKnown(entryE6, source) ? (entryE6 as bigint) : 0n;
}

export interface EntryPriceDisplay {
  known: boolean;
  text: string;
  title: string | undefined;
}

export function describeEntryPrice(input: {
  entryE6: bigint | null | undefined;
  source: EntryPriceSource | null | undefined;
  formatPrice?: (priceE6: bigint) => string;
  unknownText?: string;
}): EntryPriceDisplay {
  const unknownText = input.unknownText ?? "—";
  if (!isEntryKnown(input.entryE6, input.source)) {
    return { known: false, text: unknownText, title: UNKNOWN_ENTRY_TOOLTIP };
  }
  const format = input.formatPrice ?? ((e6: bigint) => formatUsdPriceE6(e6));
  const text = format(input.entryE6 as bigint);
  // Same text as the trade-terminal surfaces (PositionsDock/PositionPanel
  // show a derived entry unprefixed); the tooltip says it is an estimate.
  return { known: true, text, title: input.source === "derived" ? DERIVED_ENTRY_TOOLTIP : undefined };
}
