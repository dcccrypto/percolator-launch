/**
 * One approval for a Privy EMBEDDED wallet's batch.
 *
 * Privy's embedded wallet is registered as a wallet-standard wallet named
 * "Privy", so PrivyProviderClient's batch path finds its
 * `solana:signTransaction` feature and calls it with every transaction at once.
 * But that feature does not batch: it loops `for (tx of inputs) await
 * embedded.signTransaction(tx)`, and each of those calls opens Privy's own
 * confirmation modal unless its `uiOptions.showWalletUIs` is `false`
 * (@privy-io/react-auth 3.41, useWallets chunk + `isHeadlessSigning`). A fresh
 * launch is a 7-8 tx batch, so an embedded wallet clicked through 7-8 modals
 * plus the two signMessage prompts, while an external wallet approves the
 * same batch once.
 *
 * The fix keeps Privy's modal on the FIRST transaction, worded as the approval
 * for the whole batch, and signs the rest of the SAME batch without a modal.
 * Rejecting that modal throws before anything else is signed, so the user still
 * approves every batch exactly once, the same as Phantom or Solflare.
 */

/** Options shape Privy's embedded `signTransaction` reads (`options.uiOptions`). */
export interface PrivyBatchSignOptions {
  uiOptions: {
    showWalletUIs?: boolean;
    description?: string;
    buttonText?: string;
  };
}

/**
 * True for Privy's own embedded wallet. `ConnectedStandardSolanaWallet` has no
 * `walletClientType`; the embedded wallet's standard wallet exposes
 * `isPrivyWallet === true` and a `"privy:"` feature, and no external wallet does.
 */
export function isPrivyEmbeddedStandardWallet(std: unknown): boolean {
  if (typeof std !== "object" || std === null) return false;
  const s = std as { isPrivyWallet?: unknown; features?: unknown };
  if (s.isPrivyWallet === true) return true;
  return typeof s.features === "object" && s.features !== null && "privy:" in s.features;
}

/**
 * Per-transaction options for a batch of `total` signed by an embedded wallet.
 * Index 0 shows the modal as the approval for all `total`; every later index is
 * signed without one. A single transaction keeps Privy's default modal.
 */
export function embeddedBatchSignOptions(index: number, total: number): PrivyBatchSignOptions | undefined {
  if (total <= 1) return undefined;
  if (index === 0) {
    return {
      uiOptions: {
        description: `This one approval signs all ${total} transactions for this step. Nothing is sent until all ${total} are signed.`,
        buttonText: `Approve all ${total}`,
      },
    };
  }
  return { uiOptions: { showWalletUIs: false } };
}
