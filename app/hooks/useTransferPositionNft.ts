"use client";

import { useState, useCallback } from "react";
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useUserAccount } from "@/hooks/useUserAccount";
import { usePositionNft } from "@/hooks/usePositionNft";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";

/**
 * Transfer a Position NFT to another wallet.
 *
 * This is a plain Token-2022 TransferChecked. The NFT mint has a TransferHook
 * extension pointing at percolator-nft, so the hook runs automatically inside
 * the same transaction and:
 *
 *   1. Rejects if the underlying position is below maintenance margin.
 *   2. Settles funding (records the current funding index on the PDA).
 *   3. CPIs into percolator-prog with `TransferOwnershipCpi` (tag 69), which
 *      changes `Account.owner` inside the slab from sender → destination.
 *
 * The frontend does not need to touch the slab directly. The hook sees the
 * amount+mint and does the rest, atomically.
 *
 * ExtraAccountMetaList resolution is handled by
 * `createTransferCheckedWithTransferHookInstruction` — it reads the
 * ExtraAccountMetaList PDA off-chain and appends the right extra accounts
 * (mint_auth, slab, percolator_prog, ...) to the ix. Without this helper we
 * would have to hand-roll that list and keep it in sync with
 * percolator-nft/src/processor.rs — not worth it.
 */
export function useTransferPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey, signTransaction } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const userAccount = useUserAccount();
  const { nftMint } = usePositionNft(slabAddress);
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transfer = useCallback(
    async (destinationWallet: PublicKey): Promise<string | null> => {
      setError(null);
      if (!walletPubkey || !userAccount || !nftMint) {
        setError("Wallet not connected, no position, or NFT not minted");
        return null;
      }
      if (!signTransaction) {
        setError("Wallet does not support signing");
        return null;
      }
      if (destinationWallet.equals(walletPubkey)) {
        setError("Destination must be a different wallet");
        return null;
      }

      setLoading(true);
      try {
        const sourceAta = getAssociatedTokenAddressSync(
          nftMint,
          walletPubkey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const destAta = getAssociatedTokenAddressSync(
          nftMint,
          destinationWallet,
          false,
          TOKEN_2022_PROGRAM_ID,
        );

        // Idempotent create of the destination ATA (no-op if it already
        // exists). Sender pays rent. Using idempotent avoids needing to
        // getAccountInfo first — the runtime short-circuits the ix when the
        // account is already initialized.
        const createDestAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          walletPubkey,        // payer
          destAta,             // ata
          destinationWallet,   // owner
          nftMint,             // mint
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // TransferChecked with automatic transfer-hook account resolution.
        // amount=1n, decimals=0 — position NFTs are always supply=1, decimals=0.
        const transferIx = await createTransferCheckedWithTransferHookInstruction(
          connection,
          sourceAta,
          nftMint,
          destAta,
          walletPubkey,
          1n,
          0,
          [],                   // multiSigners
          "confirmed",          // commitment for extra-accounts fetch
          TOKEN_2022_PROGRAM_ID,
        );

        const tx = new Transaction();
        // The transfer hook does several reads + a CPI; 300k CU is comfortable.
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
        tx.add(createDestAtaIx);
        tx.add(transferIx);

        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = walletPubkey;

        // Pre-flight simulation. Surfaces transfer-hook rejections
        // (PositionInLiquidation, FundingOverflow, InvalidPercolatorProgram, ...)
        // before the user is prompted to sign. humanizeError will pick the
        // NFT_ERROR_CODE_MAP branch because the NFT program id is in the logs.
        {
          const sim = await connection.simulateTransaction(tx, undefined, true);
          if (sim.value.err) {
            const logs = sim.value.logs ?? [];
            const relevant = logs
              .filter((l) => l.includes("Program log:") || l.includes("failed"))
              .slice(-5)
              .join("\n");
            throw new Error(
              `NFT transfer simulation failed: ${JSON.stringify(sim.value.err)}` +
                (relevant ? `\n${relevant}` : ""),
            );
          }
        }

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true, // already simulated
          maxRetries: 5,
        });
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );

        toast(`Position NFT sent to ${destinationWallet.toBase58().slice(0, 8)}…`, "success");
        return sig;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        const msg = humanizeError(raw);
        console.error("[useTransferPositionNft]", raw);
        setError(msg);
        toast(msg, "error");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [walletPubkey, userAccount, nftMint, signTransaction, connection, toast],
  );

  return { transfer, loading, error };
}
