"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { fetchCreatorFeesClaimed, type ClaimedTotal } from "@/lib/creator-fee-history";

export type ClaimedState =
  | { kind: "loading" }
  | { kind: "error" }
  | ({ kind: "ready" } & ClaimedTotal);

const LOADING: ClaimedState = { kind: "loading" };
/** A failed read is retried once after this long (a lagging RPC node usually catches up). */
export const CLAIMED_RETRY_MS = 4_000;

/**
 * All-time creator fees `claimant` has claimed on the SlabProvider's market
 * (lib/creator-fee-history.ts). Pass null to skip the scan (not the claim authority).
 * `claimable` re-runs the scan when it changes: every claim (this market's panel or the
 * /my-markets claim-all) debits it, so a new claim is picked up as soon as the balance drops.
 * The scan is incremental (only signatures newer than the cached checkpoint), so a re-run with
 * no new vault activity is one signature-list call.
 *
 * A failed re-scan shows "error", not the previous total: that figure may be missing a claim
 * that just landed, and an old lower number reads as fact. One retry follows automatically.
 */
export function useCreatorFeesClaimed(claimant: string | null, claimable: bigint): ClaimedState {
  const { connection } = useConnectionCompat();
  const { slabAddress, programId, config } = useSlabState();
  const programIdStr = programId?.toBase58() ?? null;
  const mintStr = config?.collateralMint.toBase58() ?? null;
  // Tagged with the market and wallet it was read for: another market's figure never shows.
  const scope = `${slabAddress}:${claimant}`;
  const [state, setState] = useState<{ scope: string; value: ClaimedState }>({ scope, value: LOADING });
  // Bumped by the one automatic retry after a failed read.
  const [retryTick, setRetryTick] = useState(0);
  const lastRetryTick = useRef(retryTick);
  const retriesLeft = useRef(1);

  useEffect(() => {
    if (!claimant || !connection || !slabAddress || !programIdStr || !mintStr) return;
    // A run started by anything but the retry itself gets a fresh retry.
    if (retryTick === lastRetryTick.current) retriesLeft.current = 1;
    lastRetryTick.current = retryTick;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // A re-scan keeps the figure on screen while it runs; a new market or a past error shows loading.
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
        if (cancelled) return;
        setState({ scope, value: { kind: "error" } });
        if (retriesLeft.current > 0) {
          retriesLeft.current--;
          retryTimer = setTimeout(() => setRetryTick((n) => n + 1), CLAIMED_RETRY_MS);
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [claimant, connection, slabAddress, programIdStr, mintStr, claimable, scope, retryTick]);

  return state.scope === scope ? state.value : LOADING;
}
