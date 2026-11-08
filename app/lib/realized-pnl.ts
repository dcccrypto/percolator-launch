/**
 * M7: realized PnL that RECONCILES with the chain.
 *
 * A trade's true result is the change of the account's value across it: capital moves for a realized loss, fees and the matcher's
 * spread (all of them come out of capital), and a realized profit lands in `pnl` (released later). So
 *
 *     realized = (capital_after + pnl_after) - (capital_before + pnl_before)
 *
 * measured from two reads of the portfolio around the close. It is never the engine's crystallized-loss counter or a sum of fees,
 * which leave the spread out (council: "realized -$0.20" against a true -$1.02).
 */
import { formatTokenAmount } from "@/lib/format";

export interface EquitySnap {
  capital: bigint;
  /** Settled PnL on the account (positive = realized profit not yet converted to capital). */
  pnl: bigint;
}

export function realizedFromEquity(before: EquitySnap, after: EquitySnap): bigint {
  return after.capital + after.pnl - (before.capital + before.pnl);
}

/** "+0.12 USDC" / "−0.41 USDC" (real minus sign, so a loss can never read as a gain). */
export function formatSignedAtoms(delta: bigint, decimals: number, symbol: string): string {
  const mag = delta < 0n ? -delta : delta;
  const sign = delta > 0n ? "+" : delta < 0n ? "−" : "";
  return `${sign}${formatTokenAmount(mag, decimals)} ${symbol}`;
}

/**
 * The close toast: what was closed, the price it executed at (when read), and the realized result from the capital delta, with
 * fees and spread included. A result that could not be measured says nothing about money.
 */
export function closeResultText(o: {
  base: string;
  execPriceText: string | null;
  realized: bigint | null;
  decimals: number;
  symbol: string;
}): string {
  const parts = [o.base];
  if (o.execPriceText) parts.push(`Executed at ${o.execPriceText}.`);
  if (o.realized !== null) parts.push(`Realized ${formatSignedAtoms(o.realized, o.decimals, o.symbol)} (fees and spread included).`);
  return parts.join(" ");
}

// ── per-device ledger of realized results, for the Portfolio ─────────────────────────────────────────────────────────────────────
// The chain keeps no "net realized" figure (only a crystallized-loss counter that omits the spread), so each close records its
// measured delta here, per wallet + market. It is a device-local sum of the closes made in this browser: the Portfolio words it so.

const KEY = (wallet: string, slab: string) => `perc:realized:v1:${wallet}:${slab}`;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function recordRealized(wallet: string | null | undefined, slab: string, delta: bigint): void {
  if (!wallet) return;
  try {
    const st = store();
    if (!st) return;
    const cur = getRealized(wallet, slab) ?? 0n;
    st.setItem(KEY(wallet, slab), (cur + delta).toString());
  } catch {
    /* storage unavailable: the toast still told the user */
  }
}

/** Sum of the measured results of this device's closes on the market, or null when none were recorded. */
export function getRealized(wallet: string | null | undefined, slab: string): bigint | null {
  if (!wallet) return null;
  try {
    const raw = store()?.getItem(KEY(wallet, slab));
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
export function pendingTag(pendingProfit: bigint, realizedNet: bigint | null, crystallizedLoss: bigint): "profit settling" | "claim pending" | "idle collateral" {
  if (pendingProfit <= 0n) return "idle collateral";
  if (realizedNet !== null) return realizedNet > 0n ? "profit settling" : "claim pending";
  return crystallizedLoss > 0n ? "claim pending" : "profit settling";
}
