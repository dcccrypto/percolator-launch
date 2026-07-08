"use client";

import { useState, useCallback } from "react";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { usePositionNft } from "@/hooks/usePositionNft";
import { sendTx, type WalletLike } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import {
  deriveMintAuthority,
  deriveExtraAccountMetas,
  deriveNftRegistry,
  encodeNftEmergencyBurn,
} from "@percolatorct/sdk";

/** Mirrors useBurnPositionNft's PositionNftOverride — kept as a local copy
 *  (rather than importing from useBurnPositionNft.ts) so this module has no
 *  dependency back on the hook that calls INTO it (useBurnPositionNft falls
 *  back to sendEmergencyBurn below on LegNotActive). */
export interface PositionNftOverride {
  nftMint: PublicKey;
  nftPdaAddress: string;
}

export interface SendEmergencyBurnArgs {
  connection: Connection;
  wallet: WalletLike;
  walletPubkey: PublicKey;
  /** The Percolator wrapper program id that owns the wrapped portfolio (from useSlabState().programId). */
  wrapperProgramId: PublicKey;
  slabAddress: string;
  nftMint: PublicKey;
  nftPdaAddress: string;
  computeUnits?: number;
}

/**
 * Build + send EmergencyBurn (tag 5, percolator-nft) — the recovery path for a
 * Position NFT whose bound leg is no longer "active" on-chain (closed,
 * liquidated, or slot-reused while wrapped).
 *
 * A normal BurnPositionNft (tag 1) calls the program's `verify_bound_leg` gate,
 * which reverts `LegNotActive` (NFT-program error code 22) in exactly that
 * state — permanently, since the leg can never become active again. That
 * strands both the escrowed position AND the NFT mint/PDA rent with no
 * self-service way out (H8).
 *
 * EmergencyBurn uses the SAME 10-account layout as BurnPositionNft (see
 * ACCOUNTS_NFT_EMERGENCY_BURN vs ACCOUNTS_NFT_BURN in the SDK's nft.d.ts —
 * identical account order, just a different instruction tag), but the
 * on-chain handler calls the more permissive `emergency_burn_ok` check
 * instead, which tolerates a closed/liquidated/slot-reused leg while still
 * releasing the escrow + rent back to the holder.
 *
 * Exported as a plain async function (not just via the useEmergencyBurn hook
 * below) so useBurnPositionNft.ts can call it directly as an in-place retry
 * from inside its own catch block — React hooks can't be invoked
 * conditionally from an event-handler catch, but a plain function can.
 */
export async function sendEmergencyBurn({
  connection,
  wallet,
  walletPubkey,
  wrapperProgramId,
  slabAddress,
  nftMint,
  nftPdaAddress,
  computeUnits = 800_000,
}: SendEmergencyBurnArgs): Promise<string> {
  const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;
  const nftPda = new PublicKey(nftPdaAddress);
  const [mintAuth] = deriveMintAuthority(nftProgId);
  const [extraMetas] = deriveExtraAccountMetas(nftMint, nftProgId);
  const [nftRegistry] = deriveNftRegistry(wrapperProgramId, new PublicKey(slabAddress));

  // Owner's Token-2022 ATA for the NFT mint
  const holderAta = getAssociatedTokenAddressSync(
    nftMint,
    walletPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // The portfolio pubkey is read from bytes [10..42] of the NFT PDA account
  // (portfolioAccount field in the v17 199-byte layout) — same as useBurnPositionNft.
  const nftPdaAccountInfo = await connection.getAccountInfo(nftPda);
  if (!nftPdaAccountInfo) {
    throw new Error("NFT PDA account not found — was the NFT already burned?");
  }
  const portfolioPk = new PublicKey(nftPdaAccountInfo.data.slice(10, 42));

  // EmergencyBurn — 10 accounts (standalone NFT program, v17), same order as
  // BurnPositionNft (see useBurnPositionNft.ts's account comment):
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
      { pubkey: wrapperProgramId,      isSigner: false, isWritable: false }, // [9] wrapperProgram
    ],
    data: Buffer.from(encodeNftEmergencyBurn()),
  });

  return sendTx({
    connection,
    wallet,
    instructions: [ix],
    computeUnits,
  });
}

/**
 * Hook wrapper around sendEmergencyBurn for standalone use (e.g. a dedicated
 * "Recover" action), mirroring useBurnPositionNft's shape (loading/error
 * state, toasts, refresh-on-success). useBurnPositionNft itself does NOT use
 * this hook — it calls sendEmergencyBurn directly as an automatic in-place
 * fallback (see the comment on sendEmergencyBurn above for why).
 */
export function useEmergencyBurn(slabAddress: string, override?: PositionNftOverride) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId, refresh } = useSlabState();
  const scanned = usePositionNft(slabAddress);
  const nftMint = override?.nftMint ?? scanned.nftMint;
  const nftPdaAddress = override?.nftPdaAddress ?? scanned.nftPdaAddress;
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emergencyBurn = useCallback(async () => {
    if (!walletPubkey || !programId || !nftMint || !nftPdaAddress) {
      setError(
        nftMint
          ? "Wallet not connected or market not loaded"
          : "No NFT to recover"
      );
      return;
    }

    setLoading(true);
    setError(null);

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
      toast("Position NFT recovered (emergency burn)", "success");
      return sig;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg = humanizeError(errMsg);
      console.error("[useEmergencyBurn]", errMsg);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, nftMint, nftPdaAddress, slabAddress, connection, wallet, toast, refresh]);

  return { emergencyBurn, loading, error };
}
