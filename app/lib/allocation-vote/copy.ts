/**
 * Public copy for /allocation. The figures here are the published terms, not
 * data: the per-wallet figures only ever come from the server-side lookup.
 */
export const ALLOCATION_COPY = {
  title: "PERC allocation checker",
  terms: [
    "Holders in the 7 Nov 2026 snapshot share a guaranteed floor of 20% of the full $250,000 raise ($50,000), split in proportion to snapshot balance.",
    "If you commit more than your allocation, the excess commitment is refunded.",
    "All figures are provisional until the raise.",
  ],
  instructions: "Paste one Solana wallet address. Only that wallet is looked up.",
  provisionalNote: "Provisional until the raise.",
  /** Shown instead of "Snapshot balance" for an owner counted under an approved balance exception. */
  exceptionBalanceLabel: "Counted balance (approved exception)",
} as const;

/** Labels for the known exclusion reason codes stored with the snapshot. */
export const EXCLUSION_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "off-curve": "Off-curve address: a program-derived account, not a user wallet",
  LP: "Liquidity pool, vault or program-owned account",
  burn: "Burn address",
});
