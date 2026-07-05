"use client";

import { useState, useCallback } from "react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { usePositionNft } from "@/hooks/usePositionNft";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import {
  deriveMintAuthority,
  deriveExtraAccountMetas,
  deriveNftRegistry,
  encodeNftBurn,
  isV17Account,
} from "@percolatorct/sdk";

export function useBurnPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId, raw, refresh } = useSlabState();
  const { nftMint, nftPdaAddress } = usePositionNft(slabAddress);
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const burn = useCallback(async () => {
    if (!walletPubkey || !programId || !nftMint || !nftPdaAddress) {
      setError(
        nftMint
          ? "Wallet not connected or market not loaded"
          : "No NFT to burn — mint a position NFT first"
      );
      return;
    }

    const isV17 = raw != null && raw.length > 0 && isV17Account(raw);
    if (!isV17) {
      setError("Position NFT burn is only supported on v17 markets.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;
      const nftPda = new PublicKey(nftPdaAddress);
      const [mintAuth]    = deriveMintAuthority(nftProgId);
      const [extraMetas]  = deriveExtraAccountMetas(nftMint, nftProgId);
      const [nftRegistry] = deriveNftRegistry(programId, new PublicKey(slabAddress));

      // Owner's Token-2022 ATA for the NFT mint
      const holderAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );

      // BurnPositionNft — 10 accounts (standalone NFT program, v17):
      //  [0] holder           signer+writable (receives lamports on close)
      //  [1] nftPda           writable
      //  [2] nftMint          writable
      //  [3] holderAta        writable
      //  [4] portfolio        writable
      //  [5] mintAuthPda      readonly
      //  [6] token-2022       readonly
      //  [7] extraMetas       writable
      //  [8] nftRegistry      readonly
      //  [9] wrapperProgram   readonly
      //
      // Bugs fixed vs old hook:
      //   OLD [1]=slab (wrong), [5]=vaultAuthority (wrong), 7 accounts (wrong)
      //   NEW [1]=nftPda,       [5]=mintAuthPda,            10 accounts
      //
      // The portfolio pubkey is read from bytes [10..42] of the NFT PDA
      // account (portfolioAccount field in the v17 199-byte layout).
      const portfolioAccountInfo = await connection.getAccountInfo(nftPda);
      if (!portfolioAccountInfo) {
        throw new Error("NFT PDA account not found — was the NFT already burned?");
      }
      // portfolioAccount field at bytes [10..42] in v17 NFT PDA layout.
      const portfolioPk = new PublicKey(portfolioAccountInfo.data.slice(10, 42));

      const ix = new TransactionInstruction({
        programId: nftProgId,
        keys: [
          { pubkey: walletPubkey,          isSigner: true,  isWritable: true  }, // [0] holder
          { pubkey: nftPda,                isSigner: false, isWritable: true  }, // [1] nftPda
          { pubkey: nftMint,               isSigner: false, isWritable: true  }, // [2] nftMint
          { pubkey: holderAta,             isSigner: false, isWritable: true  }, // [3] holderAta
          { pubkey: portfolioPk,           isSigner: false, isWritable: true  }, // [4] portfolio
          { pubkey: mintAuth,              isSigner: false, isWritable: false }, // [5] mintAuthPda
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // [6] token-2022
          { pubkey: extraMetas,            isSigner: false, isWritable: true  }, // [7] extraMetas
          { pubkey: nftRegistry,           isSigner: false, isWritable: false }, // [8] nftRegistry
          { pubkey: programId,             isSigner: false, isWritable: false }, // [9] wrapperProgram
        ],
        data: Buffer.from(encodeNftBurn()),
      });

      const sig = await sendTx({
        connection,
        wallet,
        instructions: [ix],
        computeUnits: 800_000,
      });

      // Force an immediate slab re-poll so useUserAccount/usePositionNft re-scan
      // and the UI reflects the unwrapped position right after a confirmed burn.
      refresh();

      toast("Position NFT burned!", "success");
      return sig;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg = humanizeError(errMsg);
      console.error("[useBurnPositionNft]", errMsg);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, raw, nftMint, nftPdaAddress, slabAddress, connection, wallet, toast, refresh]);

  return { burn, loading, error };
}
