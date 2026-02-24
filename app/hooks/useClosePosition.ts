"use client";

import { useState, useCallback, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { AccountKind } from "@percolator/sdk";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

export interface ClosePositionResult {
  signature: string | null;
}

export interface UseClosePositionReturn {
  closePosition: (closePercent: number) => Promise<ClosePositionResult>;
  loading: boolean;
  error: string | null;
  phase: "idle" | "submitting" | "confirming";
  lastSig: string | null;
  resetPhase: () => void;
}

export function useClosePosition(slabAddress: string): UseClosePositionReturn {
  const { connection } = useConnectionCompat();
  const userAccount = useUserAccount();
  const { trade } = useTrade(slabAddress);
  const { accounts } = useSlabState();
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const inflightRef = useRef(false);

  const lpIdx = accounts.find(({ account }) => account.kind === AccountKind.LP)?.idx ?? 0;

  const resetPhase = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const closePosition = useCallback(
    async (closePercent: number): Promise<ClosePositionResult> => {
      if (inflightRef.current) throw new Error("Close already in progress");
      if (!userAccount) throw new Error("No user account");
      if (closePercent < 1 || closePercent > 100) throw new Error("Close percent must be 1-100");

      inflightRef.current = true;
      setLoading(true);
      setError(null);
      setPhase("submitting");

      try {
        // Mock mode: simulate close
        if (mockMode) {
          await new Promise((r) => setTimeout(r, 800));
          setPhase("confirming");
          setTimeout(() => setPhase("idle"), 2000);
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
        }

        // Fetch fresh on-chain data to avoid stale position sizes
        let freshPositionSize = userAccount.account.positionSize;
        try {
          const { fetchSlab, parseAccount } = await import("@percolator/sdk");
          const freshData = await fetchSlab(connection, new PublicKey(slabAddress));
          const freshAccount = parseAccount(freshData, userAccount.idx);
          freshPositionSize = freshAccount.positionSize;
        } catch {
          console.warn("[useClosePosition] Could not fetch fresh position — using cached state");
        }

        if (freshPositionSize === 0n) {
          setPhase("idle");
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
        }

        const freshAbs = freshPositionSize < 0n ? -freshPositionSize : freshPositionSize;
        const freshIsLong = freshPositionSize > 0n;

        // Compute partial close size
        let closeSize: bigint;
        if (closePercent >= 100) {
          // 100% always uses full size to avoid dust
          closeSize = freshIsLong ? -freshAbs : freshAbs;
        } else {
          const partialAbs = (freshAbs * BigInt(closePercent)) / 100n;
          closeSize = freshIsLong ? -partialAbs : partialAbs;
        }

        const sig = await withTransientRetry(
          async () => trade({ lpIdx, userIdx: userAccount.idx, size: closeSize }),
          { maxRetries: 2, delayMs: 3000 },
        );

        setLastSig(sig ?? null);
        setPhase("confirming");
        setTimeout(() => setPhase("idle"), 2000);
        return { signature: sig ?? null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[useClosePosition] error:", msg);
        setError(humanizeError(msg));
        setPhase("idle");
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, userAccount, trade, lpIdx, slabAddress, mockMode],
  );

  return { closePosition, loading, error, phase, lastSig, resetPhase };
}
