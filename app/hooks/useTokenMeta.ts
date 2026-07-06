"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { fetchTokenMeta, type TokenMeta } from "@/lib/tokenMeta";
import { getMockSymbol } from "@/lib/mock-trade-data";

/**
 * Playground sim-USDC mint. It carries no on-chain symbol metadata, so a normal
 * lookup falls through to the truncated-address fallback and surfaces as "Token"
 * via sanitizeSymbol. Resolve it to "USDC" here so collateral labels read
 * "0 USDC" everywhere. Mirrors the default in lib/config.ts (testUsdcMint).
 */
const SIM_USDC_MINT =
  process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
  "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

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

    // Known-mint override: the playground sim-USDC has no on-chain metadata.
    if (mintStr === SIM_USDC_MINT) {
      setMeta({ symbol: "USDC", name: "Sim USDC", decimals: 6 });
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
