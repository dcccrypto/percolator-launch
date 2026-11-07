/**
 * Create-wizard copy that needs a rule, not just a string (Council 2026-11-06-go1106-ux, Creator seat).
 */

/** The devnet collateral mint every market is margined in (lib/config.ts testUsdcMint, lib/tokenMeta.ts). */
function collateralMint(): string {
  return process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() || "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
}

/**
 * Pasting the collateral mint used to say "This token already has a market" and link three unrelated markets: every
 * playground market stores it as its mint_address, so the duplicate check matched all of them. It is the collateral,
 * not a market's token.
 */
export function isCollateralMint(ca: string): boolean {
  const v = ca.trim();
  return v.length > 0 && v === collateralMint();
}

export const COLLATERAL_MINT_REASON =
  "This is test USDC, the collateral every market uses, so it can't be a market's token. Paste the mint of the token you want to list.";

/**
 * The block line for a token priced below what a market can track. With no leverage low enough (BONK), it now says so
 * and what to do instead of stopping at the reason.
 */
export function priceFloorMessage(p: {
  symbol: string;
  price: string;
  minPrice: string;
  maxLeverage: number;
  /** True when some lower leverage would track this price. */
  priceAboveLowestLeverageMin: boolean;
}): string {
  const reason = `${p.symbol} trades at ${p.price}, below the ${p.minPrice} a ${p.maxLeverage}x market needs to track its price`;
  if (p.priceAboveLowestLeverageMin) return `${reason} — try lower leverage`;
  return `${reason}. ${p.symbol} can't be listed at any leverage yet: pick a token priced above ${p.minPrice}, or check back if its price rises.`;
}
