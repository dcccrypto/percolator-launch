"use client";

import { useState, useCallback } from "react";
import { PublicKey, TransactionInstruction, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { encodeMintPositionNft, getProgramId } from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";

// NFT program ID — separate from the wrapper program
const NFT_PROGRAM_ID = new PublicKey("FqhKJT9gtScjrmfUuRMjeg7cXNpif1fqsy5Jh65tJmTS");

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
      const nftProgId = NFT_PROGRAM_ID;

      // Derive PDAs — all use the NFT program
      const [nftPda] = deriveNftPda(nftProgId, slabPk, userIdx);
      const [nftMint] = deriveNftMint(nftProgId, slabPk, userIdx);
      // mint_authority PDA: ["mint_authority"] on NFT program
      const [mintAuth] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        nftProgId,
      );
      // extra-account-metas PDA: ["extra-account-metas", nft_mint] on NFT program
      const [extraMetas] = PublicKey.findProgramAddressSync(
        [Buffer.from("extra-account-metas"), nftMint.toBuffer()],
        nftProgId,
      );

      // Owner's Token-2022 ATA for the NFT mint
      const ownerAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );

      // MintPositionNft (tag 0 on NFT program)
      // 10 accounts: owner, nft_pda, nft_mint, owner_ata, slab, mint_auth, token22, ata_program, system, extra_metas
      const ix = new TransactionInstruction({
        programId: nftProgId,
        keys: [
          { pubkey: walletPubkey, isSigner: true, isWritable: true },     // 0: owner (signer, payer)
          { pubkey: nftPda, isSigner: false, isWritable: true },          // 1: nft_pda
          { pubkey: nftMint, isSigner: false, isWritable: true },         // 2: nft_mint
          { pubkey: ownerAta, isSigner: false, isWritable: true },        // 3: owner_ata
          { pubkey: slabPk, isSigner: false, isWritable: false },         // 4: slab (read-only)
          { pubkey: mintAuth, isSigner: false, isWritable: false },       // 5: mint_authority PDA
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 6: token-2022
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 7: ata_program
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 8: system
          { pubkey: extraMetas, isSigner: false, isWritable: true },      // 9: extra_account_metas PDA
        ],
        data: Buffer.from([0, userIdx & 0xff, (userIdx >> 8) & 0xff]),
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
      const raw = e instanceof Error ? e.message : String(e);
      const msg = humanizeError(raw);
      console.error("[useMintPositionNft]", raw);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, userAccount, slabAddress, connection, wallet, toast]);

  return { mint, loading, error };
}
