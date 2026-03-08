"use client";

import { useCallback, useState } from "react";
import { Keypair, PublicKey, TransactionInstruction, Transaction } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";

/** On-chain program ID (same as used across the app) */
const PROGRAM_ID_ENV = process.env.NEXT_PUBLIC_PROGRAM_ID ?? "";

/** PERC-511: ReclaimSlabRent instruction tag */
const TAG_RECLAIM_SLAB_RENT = 52;

export type ReclaimStatus = "idle" | "sending" | "success" | "error";

export interface UseReclaimSlabRentResult {
  status: ReclaimStatus;
  error: string | null;
  txSig: string | null;
  /** Call to send the ReclaimSlabRent instruction on-chain. */
  reclaim: (slabKeypair: Keypair) => Promise<void>;
}

/**
 * PERC-511: Hook that sends the ReclaimSlabRent (tag 52) instruction.
 *
 * This reclaims SOL from an uninitialised slab account (magic = 0) when
 * market creation failed mid-flow. The slab keypair must be available so
 * the slab account can sign the transaction (proves ownership).
 *
 * Accounts:
 *   [0] dest    — wallet pubkey (signer, writable) — receives reclaimed lamports
 *   [1] slab    — slab pubkey  (signer, writable) — must have magic != MAGIC on-chain
 */
export function useReclaimSlabRent(): UseReclaimSlabRentResult {
  const walletCompat = useWalletCompat();
  const { connection } = useConnectionCompat();

  const [status, setStatus] = useState<ReclaimStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  const reclaim = useCallback(
    async (slabKeypair: Keypair) => {
      if (!walletCompat.publicKey) {
        setError("Wallet not connected");
        return;
      }

      if (!walletCompat.signTransaction) {
        setError("Wallet does not support signing");
        return;
      }

      const programId = new PublicKey(PROGRAM_ID_ENV);
      const dest = walletCompat.publicKey;
      const slab = slabKeypair.publicKey;

      setStatus("sending");
      setError(null);
      setTxSig(null);

      try {
        // Verify the slab is still uninitialised on-chain before sending
        const accountInfo = await connection.getAccountInfo(slab);
        if (!accountInfo) {
          setError(
            "Slab account not found on-chain. The transaction may have already rolled back — no SOL was lost."
          );
          setStatus("error");
          return;
        }

        // Check it's owned by the program
        if (!accountInfo.owner.equals(programId)) {
          setError(
            "Slab account is not owned by the Percolator program. Cannot reclaim."
          );
          setStatus("error");
          return;
        }

        // Guard: if magic bytes = MAGIC, the market is initialised — use CloseSlab instead
        const MAGIC = 0x504552434f4c4154n;
        if (
          accountInfo.data.length >= 8 &&
          accountInfo.data.readBigUInt64LE(0) === MAGIC
        ) {
          setError(
            "This slab is already initialised (market exists). Use the normal market close flow instead of rent reclaim."
          );
          setStatus("error");
          return;
        }

        // Encode: single-byte instruction (tag 52, no additional data)
        const data = Buffer.from([TAG_RECLAIM_SLAB_RENT]);

        const ix = new TransactionInstruction({
          programId,
          keys: [
            // [0] dest — signer + writable
            { pubkey: dest, isSigner: true, isWritable: true },
            // [1] slab — signer + writable (keypair proves ownership)
            { pubkey: slab, isSigner: true, isWritable: true },
          ],
          data,
        });

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");

        const tx = new Transaction({
          feePayer: dest,
          blockhash,
          lastValidBlockHeight,
        });
        tx.add(ix);

        // Step 1: slab keypair signs (proves ownership of the uninitialised slab)
        tx.partialSign(slabKeypair);

        // Step 2: wallet (Privy) signs — uses signTransaction consistent with rest of codebase
        const signedTx = await walletCompat.signTransaction(tx);

        // Step 3: broadcast and confirm
        const sig = await connection.sendRawTransaction(signedTx.serialize(), {
          skipPreflight: false,
        });

        const confirmation = await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );

        if (confirmation.value.err) {
          throw new Error(
            `Transaction landed on-chain but was rejected by the program: ${JSON.stringify(confirmation.value.err)}`
          );
        }

        setTxSig(sig);
        setStatus("success");
      } catch (err: unknown) {
        console.error("[useReclaimSlabRent] error:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Transaction failed. Please try again."
        );
        setStatus("error");
      }
    },
    [walletCompat, connection]
  );

  return { status, error, txSig, reclaim };
}
