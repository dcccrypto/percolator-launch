"use client";

import { useEffect, useState } from "react";
import type { TopUp } from "@/lib/create-seed-check";

/**
 * Would the launch's devnet top-up (/api/devnet-pre-fund) run for this wallet right now, and would /faucet allow a claim?
 * Read-only (GET): it reserves nothing. Only asked when `enabled` (the wallet is short). A failed or unreadable answer is
 * "unknown", never "available".
 */
export function usePreFundStatus(wallet: string | null | undefined, mint: string | null | undefined, enabled: boolean): TopUp {
  const [state, setState] = useState<TopUp>({ kind: "checking" });
  useEffect(() => {
    if (!enabled || !wallet || !mint) {
      setState({ kind: "checking" });
      return;
    }
    const ctl = new AbortController();
    setState({ kind: "checking" });
    (async () => {
      try {
        const res = await fetch(`/api/devnet-pre-fund?walletAddress=${encodeURIComponent(wallet)}&mintAddress=${encodeURIComponent(mint)}`, {
          cache: "no-store",
          signal: ctl.signal,
        });
        if (!res.ok) return setState({ kind: "unknown" });
        const body = (await res.json()) as {
          known?: boolean;
          preFund?: { available?: boolean; nextClaimAt?: string | null };
          faucet?: { available?: boolean } | null;
        };
        if (!body.known || typeof body.preFund?.available !== "boolean") return setState({ kind: "unknown" });
        if (body.preFund.available) return setState({ kind: "available" });
        setState({ kind: "unavailable", nextClaimAt: body.preFund.nextClaimAt ?? null, faucetOpen: body.faucet?.available !== false });
      } catch {
        if (!ctl.signal.aborted) setState({ kind: "unknown" });
      }
    })();
    return () => ctl.abort();
  }, [wallet, mint, enabled]);
  return state;
}
