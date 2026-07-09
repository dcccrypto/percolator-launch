/**
 * PERC-356: Auto-fund hook
 *
 * When a wallet connects on devnet with < 0.1 SOL, automatically
 * calls /api/auto-fund to airdrop SOL and mint test USDC.
 *
 * Only fires once per session per wallet (deduplicated via sessionStorage so
 * dedup survives component unmount/remount on navigation — GH #1113).
 */

"use client";

import { useEffect, useCallback, useState } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";

const SS_KEY = "auto-fund-attempted";

function getAutoFundAttempted(): Set<string> {
  try {
    return new Set<string>(JSON.parse(sessionStorage.getItem(SS_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function markAutoFundAttempted(wallet: string): void {
  try {
    const s = getAutoFundAttempted();
    s.add(wallet);
    sessionStorage.setItem(SS_KEY, JSON.stringify([...s]));
  } catch {
    // sessionStorage unavailable (SSR guard) — silently skip
  }
}

export interface AutoFundResult {
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

  // `isCancelled` is threaded through from the effect below rather than a
  // hook-level ref, so it's scoped to the specific fund() call the effect
  // kicked off (fire-and-forget) — if the component unmounts (or the effect
  // re-fires for a wallet change) while the fetch is in flight, none of the
  // setState calls below run against the unmounted/superseded instance.
  const fund = useCallback(async (wallet: string, isCancelled: () => boolean) => {
    try {
      setFunding(true);
      setError(null);
      const resp = await fetch("/api/auto-fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
      });
      const data = await resp.json();
      if (isCancelled()) return;
      if (resp.ok && data.funded) {
        setResult(data);
      } else if (resp.status === 429) {
        // Already funded recently — not an error
        setResult({ funded: false, sol_airdropped: false, usdc_minted: false });
      } else if (!resp.ok) {
        setError(data.error ?? "Auto-fund failed");
      }
    } catch (e: any) {
      if (!isCancelled()) setError(e.message ?? "Network error");
    } finally {
      if (!isCancelled()) setFunding(false);
    }
  }, []);

  useEffect(() => {
    if (!connected || !publicKey) return;

    const isDevnet =
      (process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK) === "devnet";
    if (!isDevnet) return;

    const walletAddr = publicKey.toBase58();
    if (getAutoFundAttempted().has(walletAddr)) return;
    markAutoFundAttempted(walletAddr);

    // Fire and forget — don't block UI. `cancelled` guards the setState calls
    // inside fund() against firing after this effect's cleanup (unmount, or a
    // wallet switch re-running the effect) — see the comment on fund() above.
    let cancelled = false;
    fund(walletAddr, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, fund]);

  return { funding, result, error };
}
