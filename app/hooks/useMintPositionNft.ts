"use client";

import { useState, useCallback } from "react";
import { PublicKey, Keypair, TransactionInstruction, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { encodeMintPositionNft, getProgramId } from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import { PERCOLATOR_NFT_PROGRAM_ID, deriveNftPda } from "@/lib/nft-program";

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
      const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;

      // Derive PDA for state, generate fresh keypair for mint
      const [nftPda] = deriveNftPda(slabPk, userIdx);
      // nft_mint is a fresh keypair (not a PDA) — the program creates it via
      // create_account which requires the mint account to sign the transaction
      const nftMintKeypair = Keypair.generate();
      const nftMint = nftMintKeypair.publicKey;

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
          { pubkey: nftMint, isSigner: true, isWritable: true },          // 2: nft_mint (SIGNER — fresh keypair)
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

      // Build and sign manually — Privy embedded wallets can't handle extra
      // keypair signers through the standard sendTx flow. We:
      // 1. Build the tx with compute budget
      // 2. Sign with the keypair first (partialSign)
      // 3. Send to Privy for wallet signature (signTransaction)
      // 4. Re-add the keypair signature (Privy may strip it)
      // 5. Send raw transaction ourselves
      const { ComputeBudgetProgram } = await import("@solana/web3.js");
      const tx = new (await import("@solana/web3.js")).Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      tx.add(ix);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = walletPubkey;

      // Keypair signs first
      tx.partialSign(nftMintKeypair);

      // Wallet signs (Privy)
      if (!wallet.signTransaction) throw new Error("Wallet does not support signTransaction");
      const signed = await wallet.signTransaction(tx);

      // Privy may have stripped the keypair sig — re-add it
      signed.partialSign(nftMintKeypair);

      // Send
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });

      // Wait for confirmation with blockhash-based expiry
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

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
