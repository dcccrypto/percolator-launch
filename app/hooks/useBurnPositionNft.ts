"use client";

import { useState, useCallback } from "react";
import { TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { usePositionNft } from "@/hooks/usePositionNft";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import {
  deriveMintAuthority,
  deriveNftPda,
  NFT_BURN_TAG,
  PERCOLATOR_NFT_PROGRAM_ID,
} from "@/lib/nft-program";

export function useBurnPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const userAccount = useUserAccount();
  const { nftMint } = usePositionNft(slabAddress);
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const burn = useCallback(async () => {
    if (!walletPubkey || !programId || !userAccount || !nftMint) {
      setError("Wallet not connected, no user account, or no NFT to burn");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const portfolioPk = userAccount.portfolioPubkey;
      const assetIndex = userAccount.assetIndex;
      if (!portfolioPk || assetIndex === undefined) {
        throw new Error("No active v17 portfolio position found to burn as an NFT");
      }

      const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;
      const [nftPda] = deriveNftPda(portfolioPk, assetIndex, nftProgId);
      const [mintAuth] = deriveMintAuthority(nftProgId);

      // Owner's Token-2022 ATA for the NFT mint
      const ownerAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );

      // Build standalone NFT BurnPositionNft instruction (tag 1).
      // Accounts: [holder, nft_pda, nft_mint, holder_ata, portfolio, mint_auth, token22]
      const ix = new TransactionInstruction({
        programId: nftProgId,
        keys: [
          { pubkey: walletPubkey, isSigner: true, isWritable: true },    // holder
          { pubkey: nftPda, isSigner: false, isWritable: true },         // nft_pda
          { pubkey: nftMint, isSigner: false, isWritable: true },        // nft_mint
          { pubkey: ownerAta, isSigner: false, isWritable: true },       // holder_ata
          { pubkey: portfolioPk, isSigner: false, isWritable: false },   // portfolio
          { pubkey: mintAuth, isSigner: false, isWritable: false },      // mint_authority PDA
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token-2022
        ],
        data: Buffer.from([NFT_BURN_TAG]),
      });

      const sig = await sendTx({
        connection,
        wallet,
        instructions: [ix],
        computeUnits: 300_000,
      });

      toast("Position NFT burned!", "success");
      return sig;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = humanizeError(raw);
      console.error("[useBurnPositionNft]", raw);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, userAccount, nftMint, slabAddress, connection, wallet, toast]);

  return { burn, loading, error };
}
