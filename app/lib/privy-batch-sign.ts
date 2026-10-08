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
 *
 * A rejection ends the sign: PrivyProviderClient rethrows it from every attempt
 * (`isWalletRejection`) instead of trying the next signer, so one cancel is one
 * prompt. And a headless failure partway through an embedded batch is NOT
 * retried through a signer that would prompt again (`EmbeddedBatchSignError`).
 * `signAllTransactions` only ever returns when EVERY transaction is signed, so
 * a partially signed batch can never reach a broadcast.
 */
import { detectWalletError, UserFacingError } from "@/lib/errorMessages";

/**
 * True when the error is the user declining a wallet prompt, classified the way
 * the rest of the app does it (`detectWalletError` in lib/errorMessages, which
 * also drives humanizeError's "Transaction cancelled."), plus the EIP-1193
 * `code: 4001` some wallets throw without a message.
 */
export function isWalletRejection(e: unknown): boolean {
  if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === 4001) return true;
  let msg = "";
  try {
    msg = e instanceof Error ? `${e.name} ${e.message}` : typeof e === "string" ? e : String((e as { message?: unknown } | null)?.message ?? "");
  } catch {
    msg = "";
  }
  return detectWalletError(msg) === "rejected";
}

/**
 * An embedded wallet failed (not a rejection) while signing a batch. The user
 * already saw the one "Approve all N" prompt, so retrying through a signer that
 * prompts per transaction, or showing the batch prompt again, would ask them to
 * approve the same thing a second time without saying why. Nothing was sent;
 * the caller shows this line and the user chooses to try again.
 */
export class EmbeddedBatchSignError extends UserFacingError {
  constructor(public readonly total: number, options?: { cause?: unknown }) {
    super("Signing didn't finish, so nothing was sent. Please try again.");
    this.name = "EmbeddedBatchSignError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

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
