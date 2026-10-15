/** v2.2 QA RT5-2: a wallet request that ended without a signature and without the user declining (lib/v22/sign-guard.ts). */
export const WALLET_REQUEST_CLOSED_COPY = "The wallet request timed out. Nothing was sent — try again.";
/** v2.2 QA (create step 1, 2026-10-15): the wallet refused without showing this request because one of its own windows is already open (lib/v22/sign-guard.ts). */
export const WALLET_BUSY_COPY =
  "Your wallet already has a request window open, so it did not show this one. Finish or close that window (it may be behind this one), then try again. Nothing was sent.";
