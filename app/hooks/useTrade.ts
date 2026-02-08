"use client";

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  encodeTradeCpi,
  ACCOUNTS_TRADE_CPI,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  WELL_KNOWN,
} from "@percolator/core";
import { sendTx } from "@/lib/tx";
import { config } from "@/lib/config";
import { useSlabState } from "@/components/providers/SlabProvider";

export function useTrade(slabAddress: string) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { config: mktConfig, accounts } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trade = useCallback(
    async (params: { lpIdx: number; userIdx: number; size: bigint }) => {
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig) throw new Error("Wallet not connected or market not loaded");
        const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
        if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

        const programId = new PublicKey(config.programId);
        const slabPk = new PublicKey(slabAddress);
        const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);

        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_TRADE_CPI, [
            wallet.publicKey,
            lpAccount.account.owner,
            slabPk,
            WELL_KNOWN.clock,
            slabPk,
            lpAccount.account.matcherProgram,
            lpAccount.account.matcherContext,
            lpPda,
          ]),
          data: encodeTradeCpi({ lpIdx: params.lpIdx, userIdx: params.userIdx, size: params.size.toString() }),
        });
        return await sendTx({ connection, wallet, instructions: [ix], computeUnits: 400_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, slabAddress]
  );

  return { trade, loading, error };
}
