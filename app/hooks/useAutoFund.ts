/**
 * PERC-356: Auto-fund hook
 *
 * When a wallet connects on devnet with < 0.1 SOL, automatically
 * calls /api/auto-fund to airdrop SOL and mint test USDC.
 *
 * Only fires once per session per wallet (deduplicated via ref).
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";

interface AutoFundResult {
  funded: boolean;
  sol_airdropped: boolean;
  usdc_minted: boolean;
  sol_amount?: number;
  usdc_amount?: number;
}

export function useAutoFund() {
  const { publicKey, connected } = useWalletCompat();
  const [funding, setFunding] = useState(false);
  const [result, setResult] = useState<AutoFundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attemptedRef = useRef<Set<string>>(new Set());

  const fund = useCallback(async (wallet: string) => {
    try {
      setFunding(true);
      setError(null);
      const resp = await fetch("/api/auto-fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await resp.json();
      if (resp.ok && data.funded) {
        setResult(data);
      } else if (resp.status === 429) {
        // Already funded recently — not an error
        setResult({ funded: false, sol_airdropped: false, usdc_minted: false });
      } else if (!resp.ok) {
        setError(data.error ?? "Auto-fund failed");
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setFunding(false);
    }
  }, []);

  useEffect(() => {
    if (!connected || !publicKey) return;

    const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";
    if (!isDevnet) return;

    const walletAddr = publicKey.toBase58();
    if (attemptedRef.current.has(walletAddr)) return;
    attemptedRef.current.add(walletAddr);

    // Fire and forget — don't block UI
    fund(walletAddr);
  }, [connected, publicKey, fund]);

  return { funding, result, error };
}
