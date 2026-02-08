"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { fetchTokenMeta, type TokenMeta } from "@/lib/tokenMeta";

/**
 * React hook to fetch token metadata (symbol, name, decimals) for a mint.
 * Returns null while loading or if mint is null.
 */
export function useTokenMeta(mint: PublicKey | null): TokenMeta | null {
  const { connection } = useConnection();
  const [meta, setMeta] = useState<TokenMeta | null>(null);

  useEffect(() => {
    if (!mint) {
      setMeta(null);
      return;
    }

    let cancelled = false;
    fetchTokenMeta(connection, mint).then((m) => {
      if (!cancelled) setMeta(m);
    }).catch(() => {
      // keep null
    });
    return () => { cancelled = true; };
  }, [connection, mint?.toBase58()]);

  return meta;
}
