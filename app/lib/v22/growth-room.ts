/**
 * Remaining room on one side of a growth market, worded for the ticket (pure). `roomQ` is `N_cap - users' OI on the side` in Q
 * (lots x POS_SCALE on a lot market): the same number the wrapper clips an opening order to. Sizes are shown the way the whole ticket
 * shows them (tokens, `q * 10^lotExp`); on a lot market the lot count is added, so "3.7 lots" and "370 JUP" are both visible.
 */
import { fmtQ } from "@/lib/limits/format";
import { V22_COPY } from "./copy";

export interface RoomFormat {
  /** Market lot exponent (0 = a token is a lot). */
  lotExp: number;
  /** Ticker shown after a token size ("" = none). */
  ticker: string;
}

/** A Q (lots x 1e6) as a token amount: `q * 10^lotExp / 1e6`, the ticket's own size unit. */
export const sizeTokens = (q: bigint, lotExp: number): string => fmtQ(lotExp > 0 ? q * 10n ** BigInt(lotExp) : q);

/** A Q (lots x 1e6) as a lot count: `q / 1e6`. */
export const sizeLots = (q: bigint): string => fmtQ(q);

/** A Q in lots, shown as tokens (+ lots when the market has lots): "370 JUP (3.7 lots)" / "3.7 JUP". */
export function sizeWithLots(q: bigint, f: RoomFormat): string {
  const tokens = sizeTokens(q, f.lotExp);
  const base = f.ticker ? `${tokens} ${f.ticker}` : tokens;
  return f.lotExp > 0 ? `${base} (${sizeLots(q)} lots)` : base;
}

/** USD value of `q` at a per-lot e6 price: q is 1e6 per lot, the price is e6 per lot. */
export function usdOfQ(q: bigint, priceLotE6: bigint): string {
  const cents = (q * priceLotE6) / 10_000_000_000n; // q*price/1e12 USD -> cents
  const dollars = cents / 100n;
  if (dollars >= 100n) return `$${dollars.toLocaleString("en-US")}`;
  return `$${dollars.toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function roomLine(roomQ: bigint, priceLotE6: bigint, f: RoomFormat): string {
  return V22_COPY.growth.room(sizeWithLots(roomQ, f), usdOfQ(roomQ, priceLotE6));
}

export function trimLine(roomQ: bigint, fillQ: bigint, f: RoomFormat): string {
  return V22_COPY.growth.trimNotice(sizeWithLots(roomQ, f), sizeWithLots(fillQ, f));
}
