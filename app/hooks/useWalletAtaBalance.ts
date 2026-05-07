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
 *  is null, or the ATA doesn't exist yet.
 *
 *  Re-fetch trigger: pass any value as `refreshTrigger` whose identity
 *  changes when an external event invalidates the cached balance.
 *  The canonical use is the in-market `capital` value — a deposit
 *  decreases the wallet ATA balance and increases capital; passing
 *  capital as the trigger forces a re-read of the ATA so the bar
 *  reflects the post-deposit state instead of the stale pre-deposit
 *  number. Without this, only publicKey/mint/connection changes would
 *  trigger a re-read, none of which fire after a deposit/withdraw. */
export function useWalletAtaBalance(
  mint: PublicKey | null | undefined,
  refreshTrigger?: unknown,
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
        // RPC returns amount as a string. The happy-path zero balance
        // is "0" (truthy in JS). The else branch only fires for the
        // unusual empty-string / falsy case from a malformed response;
        // even then we want to preserve any decimals the RPC did
        // hand back rather than silently drop them.
        const onChainDecimals =
          info.value.decimals !== undefined ? info.value.decimals : null;
        if (info.value.amount) {
          setState({
            balance: BigInt(info.value.amount),
            decimals: onChainDecimals,
          });
        } else {
          setState({ balance: null, decimals: onChainDecimals });
        }
      } catch {
        // ATA may not exist yet (user hasn't received this token), keep null.
        if (!cancelled) setState({ balance: null, decimals: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicKey, mint, connection, refreshTrigger]);

  return state;
}
