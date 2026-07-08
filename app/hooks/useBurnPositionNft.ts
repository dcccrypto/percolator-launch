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
import { sendEmergencyBurn } from "@/hooks/useEmergencyBurn";
import {
  deriveMintAuthority,
  deriveExtraAccountMetas,
  deriveNftRegistry,
  encodeNftBurn,
  isV17Account,
} from "@percolatorct/sdk";

// H8: NFT-program error code 22 = LegNotActive (percolator-nft/src/error.rs) —
// the leg BurnPositionNft's verify_bound_leg gate expects is no longer active
// (closed, liquidated, or slot-reused while wrapped), so a normal burn reverts
// forever, stranding the escrowed position + the NFT's mint/PDA rent. This
// numerically collides with the WRAPPER program's EngineNonProgress(22) (the
// "EC" cross-program error-code collision noted in the audit), so the raw code
// alone isn't enough — only trust it when the error also names the NFT
// program, mirroring errorMessages.ts's isNftProgramError() routing (kept as
// a local, self-contained check here rather than importing that file's
// private helper).
function isLegNotActiveError(rawMsg: string): boolean {
  if (!rawMsg.includes(PERCOLATOR_NFT_PROGRAM_ID.toBase58())) return false;
  const hex = rawMsg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (hex) return parseInt(hex[1], 16) === 22;
  const json = rawMsg.match(/"Custom"\s*:\s*(\d+)/);
  if (json) return parseInt(json[1], 10) === 22;
  const paren = rawMsg.match(/Custom\((\d+)\)/);
  if (paren) return parseInt(paren[1], 10) === 22;
  return false;
}

/** Lets a caller (e.g. PositionNftPanel) supply the NFT identity directly
 *  instead of relying solely on this hook's own usePositionNft() scan — used
 *  for a Position NFT received via transfer, where useNftWrappedPosition's
 *  last_holder scan is the more reliable source (see PositionNftPanel). */
export interface PositionNftOverride {
  nftMint: PublicKey;
  nftPdaAddress: string;
}

export function useBurnPositionNft(slabAddress: string, override?: PositionNftOverride) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId, raw, refresh } = useSlabState();
  const scanned = usePositionNft(slabAddress);
  const nftMint = override?.nftMint ?? scanned.nftMint;
  const nftPdaAddress = override?.nftPdaAddress ?? scanned.nftPdaAddress;
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

      // H8: a normal burn requires the bound leg to still be "active"
      // on-chain — if the position was closed or liquidated WHILE wrapped,
      // that gate reverts LegNotActive(22) forever, permanently stranding the
      // escrowed position and the NFT's mint/PDA rent (no self-service
      // recovery). Fall back in-place to EmergencyBurn (tag 5), which runs
      // the more permissive emergency_burn_ok() check instead and still
      // returns the escrow + rent to the holder. See useEmergencyBurn.ts.
      if (isLegNotActiveError(errMsg) && walletPubkey && programId) {
        try {
          const sig = await sendEmergencyBurn({
            connection,
            wallet,
            walletPubkey,
            wrapperProgramId: programId,
            slabAddress,
            nftMint,
            nftPdaAddress,
          });

          refresh();
          toast("Position was already closed elsewhere — recovered via emergency burn.", "success");
          return sig;
        } catch (emergencyErr) {
          const emergencyMsg = emergencyErr instanceof Error ? emergencyErr.message : String(emergencyErr);
          const msg = humanizeError(emergencyMsg);
          console.error("[useBurnPositionNft] EmergencyBurn fallback failed", emergencyMsg);
          setError(msg);
          toast(msg, "error");
          return;
        }
      }

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
