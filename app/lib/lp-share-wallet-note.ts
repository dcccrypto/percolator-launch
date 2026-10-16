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

/**
 * v2.2 (percolator-prog#545): a new vault's share mint is created with the COLLATERAL's decimals and the launch names it (tag 122). The
 * interim note above (#3276) was about two things a wallet got wrong: the COUNT (raw units, because the mint had 0 decimals) and the NAME
 * (an unnamed token). On v2.2 it is gated on what the chain says about THIS mint:
 *
 *   - `lpDecimals` unknown (the mint could not be read): the conservative note above, unchanged.
 *   - decimals DIFFER (the mint's own decimals vs the scale `appDecimals` this page prints shares in; only a vault from an earlier build, whose
 *     0-decimal mint can never change, printed in the collateral's scale): the conversion by the real ratio, and "unnamed" only without metadata.
 *   - decimals equal: no conversion sentence (the wallet shows the number the app shows). The unnamed-token sentence remains only when the
 *     record is known to be ABSENT (`metadataPresent === false`); present or not yet read: no note.
 *
 * Flag off the callers keep using {@link lpShareWalletNote}.
 */
export function lpShareWalletNoteV22(o: {
  /** The decimals this page prints share counts in (the share mint's own on v2.2). */
  appDecimals?: number;
  /** The share mint's own decimals, from the chain. */
  lpDecimals?: number | null;
  /** Whether the Metaplex record naming the share token exists (ours). `null` / undefined = not read. */
  metadataPresent?: boolean | null;
}): string | null {
  const ad = o.appDecimals ?? DEFAULT_COLLATERAL_DECIMALS;
  const app = Number.isInteger(ad) && ad >= 0 && ad <= 18 ? ad : DEFAULT_COLLATERAL_DECIMALS;
  const ld = o.lpDecimals;
  if (ld === undefined || ld === null || !Number.isInteger(ld) || ld < 0 || ld > 18) return lpShareWalletNote(app);
  const named = o.metadataPresent === true;
  if (ld === app) {
    return o.metadataPresent === false
      ? `Your wallet shows LP shares as an unnamed token. That's expected — nothing extra was minted to you. Their value is shown in Earn.`
      : null;
  }
  if (ld < app) {
    const perShare = 10n ** BigInt(app - ld);
    return (
      `Your wallet shows LP shares ${named ? "under their name" : "as an unnamed token"}, counted in raw units: ` +
      `1 share here is ${fmt(perShare)} in your wallet, so 1,000 shares read as ${fmt(1_000n * perShare)}. ` +
      `That's expected — nothing extra was minted to you. Their value is shown in Earn.`
    );
  }
  // The mint counts in finer units than this page prints (an empty market switched to a finer collateral after its vault existed).
  return (
    `Your wallet counts these shares in finer units than Earn does, so the number there is larger: ` +
    `1 share here is ${fmt(10n ** BigInt(ld - app))} in your wallet. That's expected — nothing extra was minted to you. Their value is shown in Earn.`
  );
}
