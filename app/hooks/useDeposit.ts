"use client";

import { useCallback, useRef, useState } from "react";
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
import { useSlabState } from "@/components/providers/SlabProvider";

export function useDeposit(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, programId: slabProgramId } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const deposit = useCallback(
    async (params: { userIdx: number; amount: bigint }) => {
      if (inflightRef.current) throw new Error("Deposit already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        
        // P-CRITICAL-3: Validate network before deposit
        try {
          const slabInfo = await connection.getAccountInfo(new PublicKey(slabAddress));
          if (!slabInfo) {
            throw new Error("Market not found on current network. Please switch networks in your wallet and refresh.");
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("Market not found")) throw e;
        }
        const programId = slabProgramId;
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
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, slabAddress, slabProgramId]
  );

  return { deposit, loading, error };
}
