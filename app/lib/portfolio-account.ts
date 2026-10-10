/**
 * F-3 (live SDK tests 2026-10-01): the `magic + market@16` scan that discovers a market's LP also
 * returns the LP-vault (Earn) registry (176 B, kind 5), the backing ledgers (240 B, kind 3) and
 * the NFT registry (88 B, kind 7). Reading a "matcher control word" from the tail of those reads
 * unrelated fields: on the registry, bit 0 is the low bit of feeShareBps, so an odd Earn fee share
 * made the registry look like an enabled LP. Every tail read must first prove the account is a
 * full portfolio: header kind byte (offset 10, after magic[8] + version[2]) == 2 and the full
 * portfolio length (measured on devnet: 9,563 B).
 */
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { layoutOf, isUnsupportedLayout } from "@/lib/v22/layout";

/** Header kind byte of a wrapper account: magic[8] | version u16 | kind u8. */
export const ACCOUNT_KIND_OFFSET = 10;
export const ACCOUNT_KIND_PORTFOLIO = 2;

export function isPortfolioAccount(data: Uint8Array): boolean {
  if (isDevnetV22Enabled()) {
    // v2.2: the exact length of the account's OWN VERSION (never a length guess across layouts).
    try {
      const L = layoutOf(data, "isPortfolioAccount", ACCOUNT_KIND_PORTFOLIO);
      return data.length === L.portfolio.accountLen;
    } catch (e) {
      if (isUnsupportedLayout(e)) return false;
      throw e;
    }
  }
  return data.length === V17_PORTFOLIO_ACCOUNT_LEN && data[ACCOUNT_KIND_OFFSET] === ACCOUNT_KIND_PORTFOLIO;
}
