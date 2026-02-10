"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import {
  encodeInitUser,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useInitUser(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, programId: slabProgramId } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initUser = useCallback(
    async (feePayment: bigint = 0n) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        // Check if ATA exists — create it first if not (prevents error 24)
        const instructions = [];
        try {
          await getAccount(connection, userAta);
        } catch {
          // ATA doesn't exist — create it
          const createAtaIx = createAssociatedTokenAccountInstruction(
            wallet.publicKey,     // payer
            userAta,              // ata
            wallet.publicKey,     // owner
            mktConfig.collateralMint, // mint
          );
          instructions.push(createAtaIx);
        }

        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
            wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram,
          ]),
          data: encodeInitUser({ feePayment: feePayment.toString() }),
        });
        instructions.push(ix);
        return await sendTx({ connection, wallet, instructions });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId]
  );

  return { initUser, loading, error };
}
