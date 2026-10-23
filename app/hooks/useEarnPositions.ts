"use client";

import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { readEarnPositions } from "@/lib/limits/earn-positions";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

/**
 * The connected wallet's deposit (USD) in every listed Earn vault, keyed by slab, for the hub
 * table's "Your Value" column. Includes a creator's wizard seed and escrowed pending shares.
 * Absent key = not read yet / unreadable (the row shows "—"); 0 = genuinely nothing.
 */
export function useEarnPositions(markets: readonly { slabAddress: string; decimals: number }[]): Record<string, number> {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const walletStr = wallet.publicKey?.toBase58() ?? null;
  const key = useMemo(() => markets.map((m) => `${m.slabAddress}:${m.decimals}`).join(","), [markets]);
  const [usd, setUsd] = useState<Record<string, number>>({});

  useEffect(() => {
    setUsd((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    if (!walletStr || !connection || key === "") return;
    let cancelled = false;
    const rows = key.split(",").map((s) => {
      const [slab, dec] = s.split(":");
      return { slab, decimals: Number(dec) || 6 };
    });
    const run = async () => {
      try {
        const programId = new PublicKey(getConfig().programId as string);
        const pos = await readEarnPositions(connection, programId, new PublicKey(walletStr), rows.map((r) => r.slab));
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const r of rows) {
          const p = pos.get(r.slab);
          if (p && p.valueAtoms !== null) next[r.slab] = Number(p.valueAtoms) / 10 ** r.decimals;
        }
        setUsd(next);
      } catch {
        /* keep the last good read; a failed read is not a zero */
      }
    };
    void run();
    const stop = pollWhenVisible(() => void run(), 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [connection, walletStr, key]);

  return usd;
}
