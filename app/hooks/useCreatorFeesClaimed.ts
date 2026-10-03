"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { fetchCreatorFeesClaimed, type ClaimedTotal } from "@/lib/creator-fee-history";

export type ClaimedState =
  | { kind: "loading" }
  | { kind: "error" }
  | ({ kind: "ready" } & ClaimedTotal);

const LOADING: ClaimedState = { kind: "loading" };

/**
 * All-time creator fees `claimant` has claimed on the SlabProvider's market
 * (lib/creator-fee-history.ts). Pass null to skip the scan (not the claim authority).
 * `claimable` re-runs the scan when it changes: every claim (this market's panel or the
 * /my-markets claim-all) debits it, so a new claim is picked up as soon as the balance drops.
 */
export function useCreatorFeesClaimed(claimant: string | null, claimable: bigint): ClaimedState {
  const { connection } = useConnectionCompat();
  const { slabAddress, programId, config } = useSlabState();
  const programIdStr = programId?.toBase58() ?? null;
  const mintStr = config?.collateralMint.toBase58() ?? null;
  // Tagged with the market and wallet it was read for: another market's figure never shows.
  const scope = `${slabAddress}:${claimant}`;
  const [state, setState] = useState<{ scope: string; value: ClaimedState }>({ scope, value: LOADING });

  useEffect(() => {
    if (!claimant || !connection || !slabAddress || !programIdStr || !mintStr) return;
    let cancelled = false;
    // A re-scan keeps the figure on screen; a new market or a past error shows loading.
    setState((s) => (s.scope === scope && s.value.kind === "ready" ? s : { scope, value: LOADING }));
    fetchCreatorFeesClaimed(
      connection,
      new PublicKey(programIdStr),
      new PublicKey(slabAddress),
      new PublicKey(mintStr),
      new PublicKey(claimant),
    )
      .then((t) => {
        if (!cancelled) setState({ scope, value: { kind: "ready", ...t } });
      })
      .catch((e) => {
        console.warn("[useCreatorFeesClaimed]", e);
        if (!cancelled) setState((s) => (s.scope === scope && s.value.kind === "ready" ? s : { scope, value: { kind: "error" } }));
      });
    return () => {
      cancelled = true;
    };
  }, [claimant, connection, slabAddress, programIdStr, mintStr, claimable, scope]);

  return state.scope === scope ? state.value : LOADING;
}
