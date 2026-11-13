/**
 * Portfolio Value = trading value + LP value, one rule for the Overview header and the Positions hero.
 *
 * Trading value is deposited capital + settling profit + unrealized PnL (what /portfolio always showed).
 * LP value is the redeemable value of the wallet's Earn deposits and stake positions. They are separate
 * accounts, so adding them counts nothing twice. A LP value that could not be read is left out and said so
 * (the total is then trading only), never read as $0.
 */

export interface LpValueInput {
  /** Sum of the wallet's Earn and stake redeemable values in USD; null = some position's value is unknown. */
  totalRedeemable: number | null;
  loading: boolean;
  error: string | null;
  positionCount: number;
}

export interface PortfolioValueBreakdown {
  tradingUsd: number;
  /** null when the LP value could not be read. */
  lpUsd: number | null;
  /** The LP value is still loading for the first time. */
  lpLoading: boolean;
  /** Headline number: trading + LP (LP counted only when read). */
  totalUsd: number;
}

export function isLpUnread(lp: LpValueInput): boolean {
  return (lp.error != null && lp.positionCount === 0) || lp.totalRedeemable === null;
}

export function combinePortfolioValue(tradingUsd: number, lp: LpValueInput): PortfolioValueBreakdown {
  const unread = isLpUnread(lp);
  const lpUsd = unread ? null : lp.totalRedeemable;
  return { tradingUsd, lpUsd, lpLoading: lp.loading, totalUsd: tradingUsd + (lpUsd ?? 0) };
}

const fmtUsd = (n: number): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Trading $25.00 · LP $25.03", or the LP part as "LP value unavailable (not included)". */
export function portfolioValueBreakdownText(b: PortfolioValueBreakdown): string {
  const lp = b.lpUsd === null ? "LP value unavailable (not included)" : `LP ${fmtUsd(b.lpUsd)}`;
  return `Trading ${fmtUsd(b.tradingUsd)} · ${lp}`;
}
