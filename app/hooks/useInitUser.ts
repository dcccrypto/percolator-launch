"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  encodeInitUser,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { config } from "@/lib/config";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useInitUser(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initUser = useCallback(
    async (feePayment: bigint = 1_000_000n) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig) throw new Error("Wallet not connected or market not loaded");
        const programId = new PublicKey(config.programId);
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
            wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram,
          ]),
          data: encodeInitUser({ feePayment: feePayment.toString() }),
        });
        return await sendTx({ connection, wallet, instructions: [ix] });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress]
  );

  return { initUser, loading, error };
}
