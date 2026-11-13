"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

export const COLLATERAL_BALANCE_POLL_MS = 10_000;

export interface CollateralBalance {
  /** Atoms in the wallet's token account; 0n when the account does not exist; null = not read yet. */
  balance: bigint | null;
  /** The last read failed (an RPC error): the balance is unknown, not zero. */
  readFailed: boolean;
  retry: () => void;
}

/**
 * The connected wallet's balance of `mint`, kept current while visible (a faucet claim in another tab shows up).
 * A missing token account is a real zero; an RPC error sets `readFailed` (unknown, not zero). The last good value
 * is kept beside it, but callers must treat `readFailed` as "unknown" (lib/create-seed-check.ts does).
 */
export function useCollateralBalance(
  publicKey: PublicKey | null | undefined,
  connection: Connection | null | undefined,
  mint: string | null | undefined,
  enabled = true,
): CollateralBalance {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const walletKey = publicKey?.toBase58() ?? null;

  useEffect(() => {
    setBalance(null);
    setReadFailed(false);
    if (!enabled || !publicKey || !connection || !mint) return;
    let cancelled = false;
    let ata: PublicKey;
    try {
      ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey);
    } catch {
      setReadFailed(true);
      return;
    }
    const read = async () => {
      try {
        const info = await connection.getAccountInfo(ata);
        if (cancelled) return;
        if (!info) {
          setBalance(0n);
        } else {
          const bal = await connection.getTokenAccountBalance(ata);
          if (cancelled) return;
          setBalance(BigInt(bal.value.amount));
        }
        setReadFailed(false);
      } catch {
        if (!cancelled) setReadFailed(true);
      }
    };
    void read();
    const stop = pollWhenVisible(() => void read(), COLLATERAL_BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      stop();
    };
    // walletKey, not publicKey: a refreshed wallet list hands back a new object for the same wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletKey, mint, connection, enabled, nonce]);

  return { balance, readFailed, retry };
}
