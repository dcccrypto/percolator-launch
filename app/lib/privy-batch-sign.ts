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
import { USER_DECLINED_RE, UserFacingError } from "@/lib/errorMessages";

/**
 * True when the error is the user declining a wallet prompt. Text is classified by the app's own
 * `USER_DECLINED_RE` (lib/errorMessages, the same list `detectWalletError` / humanizeError use for
 * "Transaction cancelled."); EIP-1193 `code: 4001` (and Ledger `statusCode: 0x6985`) are matched on the
 * numeric property only, so "Custom(4001)" or a policy / rate-limit "rejected" is not a decline.
 */
export function isWalletRejection(e: unknown): boolean {
  if (typeof e === "object" && e !== null) {
    const o = e as { code?: unknown; statusCode?: unknown };
    if (o.code === 4001 || o.statusCode === 0x6985) return true;
  }
  let msg = "";
  try {
    msg = e instanceof Error ? `${e.name} ${e.message}` : typeof e === "string" ? e : String((e as { message?: unknown } | null)?.message ?? "");
  } catch {
    msg = "";
  }
  return USER_DECLINED_RE.test(msg);
}

/** The line shown when an embedded batch sign fails before any rejection. */
export const EMBEDDED_BATCH_SIGN_MESSAGE = "Signing didn't finish, so nothing was sent. Please try again.";
/** Same failure inside a launch that already created part of the market (the tail is re-signed after earlier steps landed). */
export const EMBEDDED_BATCH_SIGN_MESSAGE_PARTIAL =
  "Signing didn't finish. Part of your market was already created. Press Retry to continue.";

/**
 * An embedded wallet failed (not a rejection) while signing a batch. Retrying through a signer that
 * prompts per transaction, or showing the batch prompt again, would ask the user to approve the same
 * thing twice with no explanation, so the sign stops here and the user chooses to try again. This
 * also covers a failure BEFORE any prompt shows (unsupported chain, an instant feature rejection):
 * the old fallback would have tried per-transaction prompts there, it no longer does.
 * `sentBefore` is set by a flow that has already landed earlier steps (launch tail recovery), where
 * "nothing was sent" would be false.
 */
export class EmbeddedBatchSignError extends UserFacingError {
  readonly sentBefore: boolean;
  constructor(public readonly total: number, options?: { cause?: unknown; sentBefore?: boolean }) {
    super(options?.sentBefore ? EMBEDDED_BATCH_SIGN_MESSAGE_PARTIAL : EMBEDDED_BATCH_SIGN_MESSAGE);
    this.name = "EmbeddedBatchSignError";
    this.sentBefore = options?.sentBefore ?? false;
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
