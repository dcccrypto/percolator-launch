/**
 * M7: the result of a finished trade, worded for the UI. Since the Council r10 recheck the trade book behind it is rebuilt from the position's
 * on-chain fills on a device that did not place the trade (lib/entry-chain-sync.ts), so the toast no longer says it is device-only.
 * The number itself comes from lib/trade-book.ts (price PnL on booked prices
 * over the trade's whole lifetime minus every fee_atoms, which carry the spread, minus the funding the chain moved on the position:
 * lib/funding-flow.ts). The same figure is the close toast, the Portfolio's realised sum and the close dialogs' estimate once closed.
 */
import { formatTokenAmount } from "@/lib/format";
import { holdingFeeMayApply } from "@/lib/v22/lot-registry";

/** "+0.12 USDC" / "−0.41 USDC" (real minus sign, so a loss can never read as a gain). */
export function formatSignedAtoms(delta: bigint, decimals: number, symbol: string): string {
  const mag = delta < 0n ? -delta : delta;
  const sign = delta > 0n ? "+" : delta < 0n ? "−" : "";
  return `${sign}${formatTokenAmount(mag, decimals)} ${symbol}`;
}

/**
 * The close toast: what was closed, the price the trader effectively paid / received (when derivable), and the trade's result when
 * its whole life was seen. A part that could not be measured says nothing.
 */
export function closeResultText(o: {
  base: string;
  execPriceText: string | null;
  result: bigint | null;
  decimals: number;
  symbol: string;
}): string {
  const parts = [o.base];
  if (o.execPriceText) parts.push(`Effective price ${o.execPriceText}.`);
  if (o.result !== null) parts.push(`Trade result ${formatSignedAtoms(o.result, o.decimals, o.symbol)} (trading fees, spread, other fees and funding included). Counted from this position's fills on chain.`);
  return parts.join(" ");
}

// ── per-device ledger of realized results, for the Portfolio ─────────────────────────────────────────────────────────────────────
// The chain keeps no "net realized" figure (only a crystallized-loss counter that omits the spread), so each close records its
// measured delta here, per wallet + market. It is a device-local sum of the closes made in this browser: the Portfolio words it so.

// r10: v2 = sums that include funding. v1 sums (before #3817) excluded it and are never read again, so no figure is mislabelled.
const KEY = (wallet: string, slab: string) => `perc:realized:v2:${wallet}:${slab}`;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const LAST = (wallet: string, slab: string) => `perc:realized-last:v2:${wallet}:${slab}`;

export function recordRealized(wallet: string | null | undefined, slab: string, delta: bigint): void {
  if (!wallet) return;
  // r10 (#3817 MED-1): rent has no counter, so on a market that may charge it the result is unknown: nothing is recorded.
  if (holdingFeeMayApply(slab)) return;
  try {
    const st = store();
    if (!st) return;
    const cur = getRealized(wallet, slab) ?? 0n;
    st.setItem(KEY(wallet, slab), (cur + delta).toString());
    st.setItem(LAST(wallet, slab), delta.toString());
  } catch {
    /* storage unavailable: the toast still told the user */
  }
}

/** Sum of the measured results of this device's finished trades on the market, or null when none were recorded. */
export function getRealized(wallet: string | null | undefined, slab: string): bigint | null {
  if (!wallet) return null;
  try {
    const raw = store()?.getItem(KEY(wallet, slab));
    return raw == null || !/^-?\d+$/.test(raw) ? null : BigInt(raw);
  } catch {
    return null;
  }
}

/** The result of the most recent finished trade on the market (null = none seen). */
export function getLastResult(wallet: string | null | undefined, slab: string): bigint | null {
  if (!wallet) return null;
  try {
    const raw = store()?.getItem(LAST(wallet, slab));
    return raw == null || !/^-?\d+$/.test(raw) ? null : BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * The tag on a flat account's pending (released-later) profit. "profit settling" is only for a market whose recorded result is a
 * gain; a market the user lost on, or one with a crystallized loss and no recorded result, reads "claim pending": the cash is real
 * but the trade was not a profit.
 */
export function pendingTag(pendingProfit: bigint, lastResult: bigint | null): "profit settling" | "claim pending" | "idle collateral" {
  if (pendingProfit <= 0n) return "idle collateral";
  // "profit" only when the finished trade's measured result is a gain; unknown or a loss reads neutral.
  return lastResult !== null && lastResult > 0n ? "profit settling" : "claim pending";
}
