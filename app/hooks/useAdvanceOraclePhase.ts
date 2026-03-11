"use client";

import { useEffect, useRef } from "react";
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/hooks/useSlab";
import {
  encodeAdvanceOraclePhase,
  checkPhaseTransition,
  buildIx,
  buildAccountMetas,
  ACCOUNTS_ADVANCE_ORACLE_PHASE,
  ORACLE_PHASE_MATURE,
} from "@percolator/sdk";

/**
 * PERC-622: Auto-advance oracle phase on market page load.
 *
 * Silently checks if the market is eligible for a phase transition.
 * If so, sends an AdvanceOraclePhase tx (permissionless — any wallet can call).
 * Fires at most once per market per page load.
 */
export function useAdvanceOraclePhase(slabAddress?: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config, programId } = useSlabState();
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!slabAddress || !config || !programId || !wallet.publicKey || !wallet.signTransaction) return;
    if (attemptedRef.current === slabAddress) return; // already tried this market

    // Already mature — nothing to do
    if (config.oraclePhase >= ORACLE_PHASE_MATURE) return;

    // Always attempt if phase < 2. The tx is cheap (~5K CU) and the
    // on-chain program will no-op if no transition is due.

    attemptedRef.current = slabAddress;

    (async () => {
      try {
        const slab = new PublicKey(slabAddress);
        const progPubkey = new PublicKey(programId);

        const data = encodeAdvanceOraclePhase();
        const keys = buildAccountMetas(ACCOUNTS_ADVANCE_ORACLE_PHASE, [slab]);
        const ix = buildIx({ programId: progPubkey, keys, data });

        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
          ix,
        );
        tx.feePayer = wallet.publicKey!;
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;

        const signed = await wallet.signTransaction!(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
        });

        console.log(`[PERC-622] AdvanceOraclePhase sent for ${slabAddress}: ${sig}`);
      } catch (err) {
        // Silent failure — this is a background optimization, not user-facing
        console.debug("[PERC-622] AdvanceOraclePhase failed (expected if not ready):", err);
      }
    })();
  }, [slabAddress, config, programId, wallet.publicKey, wallet.signTransaction, connection]);
}
