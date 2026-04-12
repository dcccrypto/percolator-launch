"use client";

import { useEffect, useRef } from "react";
import { useSlabState } from "@/hooks/useSlab";
import { ORACLE_PHASE_MATURE } from "@percolatorct/sdk";

/**
 * PERC-622 / GH#1120: Auto-advance oracle phase on market page load.
 *
 * Silently checks if the market is eligible for a phase transition.
 * If so, calls POST /api/oracle/advance-phase which uses a SERVER-SIDE crank
 * keypair to sign and send the AdvanceOraclePhase transaction.
 *
 * Previously this hook called wallet.signTransaction directly, which caused
 * the Privy "Confirm transaction" modal to fire on every trade page load
 * without user interaction (GH#1120). The transaction is permissionless so
 * any fee payer works — server-side is the correct approach.
 *
 * Fires at most once per market per page load (in-memory ref guard).
 * Silent failure — this is a background optimization, not user-facing.
 */
export function useAdvanceOraclePhase(slabAddress?: string) {
  const { config } = useSlabState();
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!slabAddress || !config) return;
    if (attemptedRef.current === slabAddress) return; // already tried this market

    // Already mature — nothing to do
    if (config.oraclePhase >= ORACLE_PHASE_MATURE) return;

    attemptedRef.current = slabAddress;

    // Fire-and-forget: POST to server-side route that signs with crank keypair.
    // No wallet interaction — no Privy modal.
    fetch("/api/oracle/advance-phase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slabAddress }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          console.log(`[PERC-622] AdvanceOraclePhase sent for ${slabAddress}: ${data.signature}`);
        } else {
          console.debug("[PERC-622] AdvanceOraclePhase skipped:", data.reason);
        }
      })
      .catch((err) => {
        console.debug("[PERC-622] AdvanceOraclePhase API call failed:", err);
      });
  }, [slabAddress, config]);
}
