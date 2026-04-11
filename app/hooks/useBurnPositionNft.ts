"use client";

import { useState, useCallback } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { usePositionNft } from "@/hooks/usePositionNft";
import { encodeBurnPositionNft } from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";

/**
 * Derive the position_nft PDA.
 * Seeds: ["position_nft", slab_key, user_idx as u16 LE]
 */
function deriveNftPda(programId: PublicKey, slab: PublicKey, userIdx: number): [PublicKey, number] {
  const idxBuf = new Uint8Array(2);
  new DataView(idxBuf.buffer).setUint16(0, userIdx, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft"), slab.toBytes(), idxBuf],
    programId,
  );
}

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
      const slabPk = new PublicKey(slabAddress);
      const userIdx = userAccount.idx;

      // Derive PDAs
      const [nftPda] = deriveNftPda(programId, slabPk, userIdx);
      const [vaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), slabPk.toBuffer()],
        programId,
      );

      // Owner's Token-2022 ATA for the NFT mint
      const ownerAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );

      // Build BurnPositionNft instruction (tag 66)
      // Accounts: [owner(signer), slab, nft_pda, nft_mint, owner_ata, vault_auth, token22]
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: walletPubkey, isSigner: true, isWritable: true },    // owner
          { pubkey: slabPk, isSigner: false, isWritable: true },         // slab
          { pubkey: nftPda, isSigner: false, isWritable: true },         // nft_pda
          { pubkey: nftMint, isSigner: false, isWritable: true },        // nft_mint
          { pubkey: ownerAta, isSigner: false, isWritable: true },       // owner_ata
          { pubkey: vaultAuth, isSigner: false, isWritable: false },     // vault_auth PDA
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token-2022
        ],
        data: Buffer.from(encodeBurnPositionNft({ userIdx })),
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
