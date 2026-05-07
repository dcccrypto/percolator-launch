"use client";

import { useState, useEffect } from "react";
import type { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";

export interface WalletAtaBalance {
  /** Raw atomic balance from the user's ATA, or null if no ATA / not connected. */
  balance: bigint | null;
  /** On-chain decimals from the ATA, or null if unavailable. Useful for
   *  tokens where TokenMetadata fails (cross-network, missing). */
  decimals: number | null;
}

/** Fetches the user's associated token account balance for a given mint.
 *  Returns `{ balance: null }` when the wallet is disconnected, the mint
 *  is null, or the ATA doesn't exist yet. One-shot fetch on mount /
 *  dependency change — does NOT poll, so callers that want live
 *  updates after a deposit/withdraw should rebuild on the changing
 *  market state (slab capital change, etc.). */
export function useWalletAtaBalance(
  mint: PublicKey | null | undefined,
): WalletAtaBalance {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [state, setState] = useState<WalletAtaBalance>({
    balance: null,
    decimals: null,
  });

  useEffect(() => {
    if (!publicKey || !mint) {
      setState({ balance: null, decimals: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(mint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (cancelled) return;
        if (info.value.amount) {
          setState({
            balance: BigInt(info.value.amount),
            decimals:
              info.value.decimals !== undefined ? info.value.decimals : null,
          });
        } else {
          setState({ balance: null, decimals: null });
        }
      } catch {
        // ATA may not exist yet (user hasn't received this token), keep null.
        if (!cancelled) setState({ balance: null, decimals: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, mint, connection]);

  return state;
}
