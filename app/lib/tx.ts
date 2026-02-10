import { Connection, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { Signer } from "@solana/web3.js";

export interface SendTxParams {
  connection: Connection;
  wallet: WalletContextState;
  instructions: TransactionInstruction[];
  computeUnits?: number;
  signers?: Signer[];
  /** Max retries on blockhash expiry (default 2) */
  maxRetries?: number;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 90_000;

/**
 * Poll getSignatureStatuses until confirmed or timeout.
 * More reliable than confirmTransaction which can falsely report expiry.
 */
async function pollConfirmation(
  connection: Connection,
  signature: string,
): Promise<void> {
  const start = Date.now();
  let pollCount = 0;

  while (Date.now() - start < MAX_POLL_TIME_MS) {
    pollCount++;
    try {
      const resp = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: pollCount > 5,
      });
      const status = resp.value[0];

      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return; // Success!
        }
      }
    } catch (e) {
      // If it's our own "Transaction failed" error, rethrow
      if (e instanceof Error && e.message.startsWith("Transaction failed:")) throw e;
      // Otherwise RPC hiccup — keep polling
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Confirmation timeout (${MAX_POLL_TIME_MS / 1000}s) — tx may still land. Check explorer: ${signature}`
  );
}

/**
 * Send a transaction with polling-based confirmation.
 *
 * Uses getSignatureStatuses polling instead of confirmTransaction,
 * which can falsely report "block height exceeded" when the tx
 * actually landed on-chain.
 */
export async function sendTx({
  connection,
  wallet,
  instructions,
  computeUnits = 200_000,
  signers = [],
  maxRetries = 2,
}: SendTxParams): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      for (const ix of instructions) {
        tx.add(ix);
      }

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      const signed = await wallet.signTransaction(tx);

      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });

      // Poll for confirmation instead of using confirmTransaction
      // (confirmTransaction falsely reports "block height exceeded" on devnet)
      await pollConfirmation(connection, signature);

      return signature;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);

      const isBlockhashExpired =
        msg.includes("block height exceeded") ||
        msg.includes("Blockhash not found") ||
        msg.includes("has expired");

      if (isBlockhashExpired && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}
