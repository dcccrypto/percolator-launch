"use client";

import { useCallback, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { verifyPortfolioTarget } from "@/lib/portfolio-target";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { invalidateWalletBalance } from "@/lib/wallet-balance-invalidation";
import {
  assessPortfolioBytes,
  buildCloseTradingAccountIx,
  closeAccountErrorMessage,
  closeRefusalError,
} from "@/lib/close-trading-account";

export interface CloseTradingAccountResult {
  signature: string;
  /** The account's own lamports at the fresh read: what the closer receives (the fee is paid on top). */
  lamports: number;
}

/**
 * Close ONE named trading account (#3426): the row's exact portfolio pubkey, a fresh `confirmed` read,
 * `verifyPortfolioTarget` (program, owner, market, not the LP), the emptiness re-check on those fresh bytes,
 * then a tx holding only the owner-signed ClosePortfolio. sendTx simulates it before the wallet opens, so an
 * account that is not empty (or moved) is refused before anything is signed. There is no fallback to another
 * account: a miss is an error the caller shows.
 */
export function useCloseTradingAccount(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const closeAccount = useCallback(
    async (portfolioPk: PublicKey): Promise<CloseTradingAccountResult> => {
      if (inflightRef.current) throw new Error("Close already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey) throw new Error("Wallet not connected");
        if (!programId) throw new Error("Market not loaded");
        assertKnownProgram(programId);
        const market = new PublicKey(slabAddress);
        const info = await connection.getAccountInfo(portfolioPk, "confirmed");
        const data = verifyPortfolioTarget(info, programId, market, wallet.publicKey);
        const verdict = assessPortfolioBytes(data, wallet.publicKey);
        if (!verdict.closable) throw closeRefusalError(verdict.reason);
        const ix = buildCloseTradingAccountIx({ programId, owner: wallet.publicKey, market, portfolio: portfolioPk, data });
        const signature = await sendTx({
          connection,
          wallet,
          instructions: [ix],
          computeUnits: 200_000,
          simulateBeforeSign: true,
        });
        invalidatePortfolio();
        invalidateWalletBalance();
        refreshSlab?.();
        setTimeout(() => refreshSlab?.(), 2000);
        return { signature, lamports: info?.lamports ?? 0 };
      } catch (e) {
        setError(closeAccountErrorMessage(e));
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, programId, slabAddress, refreshSlab],
  );

  return { closeAccount, loading, error };
}
