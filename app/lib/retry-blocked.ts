/**
 * Why the launch screen's Retry can't run right now, as a line for the creator, or null when it can.
 * handleRetry used to return silently in each of these cases, so the button looked dead.
 */
export const RETRY_BLOCKED_COPY = {
  noWallet: "Connect your wallet to retry. Nothing was sent.",
  invalidConfig:
    "This launch's settings are no longer valid in the form (a price, token or pool the launch needs is missing), so Retry can't rebuild the step. Nothing was sent. Start over, or reload and use the recovery card on this page.",
  noSlab:
    "This session doesn't know the market address of this launch, so Retry can't resume it. Nothing was sent. Reload and use the recovery card on this page.",
} as const;

export function retryBlockedReason(i: { hasWallet: boolean; configValid: boolean; step: number; hasSlab: boolean }): string | null {
  if (!i.hasWallet) return RETRY_BLOCKED_COPY.noWallet;
  if (!i.configValid) return RETRY_BLOCKED_COPY.invalidConfig;
  // Past step 0 the slab address is needed to resume; step 0 generates a fresh keypair.
  if (i.step > 0 && !i.hasSlab) return RETRY_BLOCKED_COPY.noSlab;
  return null;
}
