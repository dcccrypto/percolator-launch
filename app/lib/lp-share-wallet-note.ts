/**
 * percolator-prog#542 (interim, until the program gives LP share mints the
 * collateral's decimals and token metadata): the LP share mint is created with
 * 0 decimals and no metadata, so a wallet shows a creator's LP shares as an
 * unnamed token counted in RAW units. The app formats the same shares with the
 * collateral's decimals (see DepositWithdrawPanel's formatShares), so "1,000
 * shares" here reads as 1,000,000,000 in the wallet. Say so where people meet it.
 */

/** Collateral decimals on every deployment today (Sim-USDC on devnet, USDC on mainnet). */
export const DEFAULT_COLLATERAL_DECIMALS = 6;

const fmt = (n: bigint) => n.toLocaleString("en-US");

export function lpShareWalletNote(collateralDecimals: number = DEFAULT_COLLATERAL_DECIMALS): string {
  const d = Number.isInteger(collateralDecimals) && collateralDecimals >= 0 && collateralDecimals <= 18
    ? collateralDecimals
    : DEFAULT_COLLATERAL_DECIMALS;
  const perShare = 10n ** BigInt(d);
  return (
    `Your wallet shows LP shares as an unnamed token, counted in raw units: ` +
    `1 share here is ${fmt(perShare)} in your wallet, so 1,000 shares read as ${fmt(1_000n * perShare)}. ` +
    `That's expected — nothing extra was minted to you. Their value is shown in Earn.`
  );
}
