"use client";

import { useState, useCallback } from "react";
import { PublicKey, TransactionInstruction, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { encodeMintPositionNft } from "@percolator/sdk";
import { sendTx } from "@/lib/tx";
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

/**
 * Derive the position_nft_mint PDA.
 * Seeds: ["position_nft_mint", slab_key, user_idx as u16 LE]
 */
function deriveNftMint(programId: PublicKey, slab: PublicKey, userIdx: number): [PublicKey, number] {
  const idxBuf = new Uint8Array(2);
  new DataView(idxBuf.buffer).setUint16(0, userIdx, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position_nft_mint"), slab.toBytes(), idxBuf],
    programId,
  );
}

export function useMintPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId } = useSlabState();
  const userAccount = useUserAccount();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async () => {
    if (!walletPubkey || !programId || !userAccount) {
      setError("Wallet not connected or no user account");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const slabPk = new PublicKey(slabAddress);
      const userIdx = userAccount.idx;

      // Derive PDAs
      const [nftPda] = deriveNftPda(programId, slabPk, userIdx);
      const [nftMint] = deriveNftMint(programId, slabPk, userIdx);
      const [vaultAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), slabPk.toBuffer()],
        programId,
      );

      // Owner's Token-2022 ATA for the NFT mint
      const ownerAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false, // not a PDA owner
        TOKEN_2022_PROGRAM_ID,
      );

      // Build MintPositionNft instruction (tag 64)
      // Accounts: [payer, slab, nft_pda, nft_mint, owner_ata, owner, vault_auth, token22, system, rent]
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: walletPubkey, isSigner: true, isWritable: true },   // payer
          { pubkey: slabPk, isSigner: false, isWritable: true },        // slab
          { pubkey: nftPda, isSigner: false, isWritable: true },        // nft_pda
          { pubkey: nftMint, isSigner: false, isWritable: true },       // nft_mint
          { pubkey: ownerAta, isSigner: false, isWritable: true },      // owner_ata
          { pubkey: walletPubkey, isSigner: true, isWritable: false },   // owner (signer)
          { pubkey: vaultAuth, isSigner: false, isWritable: false },    // vault_auth PDA
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // token-2022
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // rent
        ],
        data: Buffer.from(encodeMintPositionNft({ userIdx })),
      });

      const sig = await sendTx({
        connection,
        wallet,
        instructions: [ix],
        computeUnits: 400_000,
      });

      toast("Position NFT minted!", "success");
      return sig;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[useMintPositionNft]", msg);
      setError(msg);
      toast("Failed to mint NFT: " + msg.slice(0, 80), "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, userAccount, slabAddress, connection, wallet, toast]);

  return { mint, loading, error };
}
