/**
 * Minimal structural type accepted from Solana RPC confirmation results.
 *
 * The optional fields intentionally make this helper fail closed when
 * an RPC provider returns a malformed or incomplete confirmation result.
 */
export interface TransactionConfirmationLike {
  value?: {
    err?: unknown | null;
  };
}

/**
 * Assert that a confirmed Solana transaction completed successfully
 * during on-chain execution.
 *
 * confirmTransaction() may resolve normally even when the transaction
 * itself failed. A successful RPC call or returned signature therefore
 * must not be treated as proof of successful execution.
 */
export function assertSuccessfulConfirmation(
  confirmation: TransactionConfirmationLike,
  operation: string,
): void {
  const executionError =
    confirmation?.value?.err;

  if (executionError === null) {
    return;
  }

  let serializedError: string;

  try {
    serializedError =
      JSON.stringify(executionError);
  } catch {
    serializedError =
      String(executionError);
  }

  throw new Error(
    `${operation} confirmed but failed on-chain: ${serializedError}`,
  );
}
