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
 * "Block height exceeded" happens when the blockhash expires between
 * signing and confirmation. This re-signs with a fresh blockhash and retries.
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
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
      for (const ix of instructions) {
        tx.add(ix);
      }

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      const signed = await wallet.signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });

      // Use a race between confirmation and timeout
      // so we don't hang forever on slow devnet
      await Promise.race([
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Confirmation timeout — tx may still land. Check explorer.")), 60_000)
        ),
      ]);

      return signature;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);

      const isBlockhashExpired =
        msg.includes("block height exceeded") ||
        msg.includes("Blockhash not found") ||
        msg.includes("expired");

      if (isBlockhashExpired && attempt < maxRetries) {
        // Wait a moment then retry with fresh blockhash
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}
