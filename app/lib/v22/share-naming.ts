/**
 * v2.2 LP / Earn share-token naming in the launch flow (tag 122 `InitLpShareMetadata`, percolator-prog#545; reviewed design:
 * ledger `security-review-v22-lp-share-mint-2026-10-08.md`).
 *
 * Wire `[122][n][ticker]`, ticker `A-Z0-9` up to 8 characters derived from the market's symbol, the generic form (n = 0) when nothing is left.
 * It rides with tag 74 in the SAME launch transaction, BEFORE any marketauth handoff (`StakeInitPool` rotates marketauth to the pool PDA;
 * after that nobody can set a ticker). marketauth signs the wrapper instruction only; the wrapper funds Metaplex from its own transient fee-payer
 * PDA, so no privileged signer reaches a Metaplex CPI. The ticker is unverified creator input.
 *
 * Flag off: nothing here is used and no tag 122 is built.
 */
import { isDevnetV22Enabled } from "./flag";
import { LP_SHARE_META_FUND_LAMPORTS_V22, lpShareTickerFromSymbolV22 } from "./sdk";

/**
 * Net lamports the naming costs the launcher: Metaplex rent for the 607-byte record plus its create fee, measured by the reviewer at
 * 15,115,600. The wallet must HOLD {@link LP_SHARE_META_FUND_LAMPORTS_V22} (30,000,000) at that instruction; the difference is returned in the same instruction.
 */
export const SHARE_NAMING_NET_LAMPORTS = 15_115_600;
export const SHARE_NAMING_HOLD_LAMPORTS = Number(LP_SHARE_META_FUND_LAMPORTS_V22);

/**
 * Whether the launch names the share. v2.2 flag on, and not switched off with `NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING=0` (a kill switch for the
 * one launch step that depends on the third-party Metaplex program, review R11). Literal env read so Next inlines it.
 */
export function isShareNamingEnabled(): boolean {
  if (!isDevnetV22Enabled()) return false;
  const v = process.env.NEXT_PUBLIC_DEVNET_V22_SHARE_NAMING;
  return !(v === "0" || v === "false");
}

/** The ticker the program accepts for a market symbol (uppercase, `A-Z 0-9` only, first 8), `""` for the generic form. */
export function shareTickerFor(symbol: string | null | undefined): string {
  return lpShareTickerFromSymbolV22(symbol);
}
