import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { V17_PORTFOLIO_ACCOUNT_LEN, v17MarketAccountLen } from "@percolatorct/sdk";

/**
 * Account lengths the wizard allocates, per flag. v2.1 (VERSION 18): market 3,675 B, portfolio 9,563 B. v2.2 (VERSION 19, deployed
 * wrapper layout, fresh-ID bring-up 2026-10): market 4,059 B (one slot), portfolio 10,603 B. Literal on purpose: these pin the
 * program's sizes, not the app's own table.
 */
export const ONE_SLOT_LEN = (): number => (isDevnetV22Enabled() ? 4_059 : 3_675);
export const PORTFOLIO_LEN = (): number => (isDevnetV22Enabled() ? 10_603 : V17_PORTFOLIO_ACCOUNT_LEN);
/** Market account length for `n` asset slots: v2.2 = 592 (header) + 806 (group) + n x 2,661; v2.1 = the SDK's v17MarketAccountLen(n). */
export const marketLen = (n: number): number => (isDevnetV22Enabled() ? 592 + 806 + n * 2_661 : v17MarketAccountLen(n));
