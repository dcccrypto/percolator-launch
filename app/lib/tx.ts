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

/**
 * Send a transaction with automatic retry on blockhash expiry.
 *
 * Optimized for devnet reliability:
 * - skipPreflight for faster submission
 * - Higher priority fee to get included faster
 * - Retries with fresh blockhash on expiry
 * - 90s confirmation timeout
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
      // Higher priority fee for devnet — helps get included when congested
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      for (const ix of instructions) {
        tx.add(ix);
      }

      // Use finalized blockhash — longer validity window on slow devnet
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      const signed = await wallet.signTransaction(tx);

      // skipPreflight = faster submission, we handle errors on confirmation
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });

      // Longer timeout for devnet — 90 seconds
      await Promise.race([
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Confirmation timeout (90s) — tx may still land. Check explorer: " + signature)), 90_000)
        ),
      ]);

      return signature;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);

      const isBlockhashExpired =
        msg.includes("block height exceeded") ||
        msg.includes("Blockhash not found") ||
        msg.includes("has expired");

      if (isBlockhashExpired && attempt < maxRetries) {
        // Wait then retry with fresh blockhash
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}
