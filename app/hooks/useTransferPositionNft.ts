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
      // Track which step we are in so an empty-message throw still gives
      // the user something actionable. Privy's wallet adapter and the
      // spl-token helpers both throw typed errors with blank .message
      // fields in several edge cases — without this tag, humanizeError
      // receives "" and falls through to a useless "Transaction failed:".
      let stage = "initializing";
      try {
        stage = "deriving ATAs";
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

        stage = "building destination ATA instruction";
        const createDestAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          walletPubkey,
          destAta,
          destinationWallet,
          nftMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // TransferChecked with automatic transfer-hook account resolution.
        // The helper fetches the mint's TransferHook extension AND the
        // ExtraAccountMetaList PDA to append the right extras to the ix.
        // Both reads can throw TokenTransferHookAccountNotFound /
        // TokenTransferHookInvalidPubkeyData with blank messages — handle
        // those explicitly below.
        stage = "resolving transfer-hook extra accounts (this fetches mint + ExtraAccountMetaList PDA)";
        const transferIx = await createTransferCheckedWithTransferHookInstruction(
          connection,
          sourceAta,
          nftMint,
          destAta,
          walletPubkey,
          1n,
          0,
          [],
          "confirmed",
          TOKEN_2022_PROGRAM_ID,
        );

        stage = "assembling transaction";
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
        tx.add(createDestAtaIx);
        tx.add(transferIx);

        stage = "fetching blockhash";
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = walletPubkey;

        stage = "pre-flight simulation";
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

        stage = "waiting for wallet signature";
        const signed = await signTransaction(tx);

        stage = "submitting transaction";
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          maxRetries: 5,
        });

        stage = "waiting for confirmation";
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );

        toast(`Position NFT sent to ${destinationWallet.toBase58().slice(0, 8)}…`, "success");
        return sig;
      } catch (e) {
        // Always log the raw error object so the browser console shows the
        // actual shape — not just .message, which is often empty for
        // wallet-adapter / spl-token typed errors.
        console.error("[useTransferPositionNft] stage:", stage, "error:", e);

        // Build a meaningful raw string even when .message is empty.
        let raw = "";
        if (e instanceof Error) {
          raw = e.message || e.name || e.constructor?.name || "";
        } else if (e != null) {
          raw = String(e);
        }
        if (!raw.trim()) {
          raw = `Failed while ${stage}. Check the browser console for the raw error object.`;
        }

        // User rejected wallet signature — surface a clean UX message and
        // do not treat it as an error state.
        if (/user (rejected|cancelled|denied)|rejected the request/i.test(raw)) {
          setError(null);
          return null;
        }

        const msg = humanizeError(raw);
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
