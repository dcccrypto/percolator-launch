"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { fetchTokenMeta, type TokenMeta } from "@/lib/tokenMeta";
import { getMockSymbol } from "@/lib/mock-trade-data";

/**
 * React hook to fetch token metadata (symbol, name, decimals) for a mint.
 * Returns null while loading or if mint is null.
 */
export function useTokenMeta(mint: PublicKey | null): TokenMeta | null {
  const { connection } = useConnectionCompat();
  const [meta, setMeta] = useState<TokenMeta | null>(null);

  useEffect(() => {
    if (!mint) {
      setMeta(null);
      return;
    }

    // Check if this mint belongs to a mock slab (design testing)
    const mintStr = mint.toBase58();
    const mockSym = getMockSymbol(mintStr);
    if (mockSym) {
      setMeta({ symbol: mockSym, name: mockSym, decimals: 6 });
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
