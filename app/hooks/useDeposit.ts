"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  encodeDepositCollateral,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  getAta,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { config } from "@/lib/config";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useDeposit(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deposit = useCallback(
    async (params: { userIdx: number; amount: bigint }) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig) throw new Error("Wallet not connected or market not loaded");
        const programId = new PublicKey(config.programId);
        const slabPk = new PublicKey(slabAddress);
        const userAta = await getAta(wallet.publicKey, mktConfig.collateralMint);

        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
            wallet.publicKey, slabPk, userAta, mktConfig.vaultPubkey, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
          ]),
          data: encodeDepositCollateral({ userIdx: params.userIdx, amount: params.amount.toString() }),
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

  return { deposit, loading, error };
}
