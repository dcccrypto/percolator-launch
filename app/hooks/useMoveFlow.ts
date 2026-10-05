"use client";

/**
 * Move-to-v2.1 orchestration hook. Scans the wallet's v1 footprint, derives the plan from chain
 * state alone (resume = scan again; nothing correctness-critical lives in localStorage), and runs
 * the steps that have a provider-free executor (creator-fee claims reuse useClaimCreatorFees).
 * Close, withdraw and Earn exits are handed off to the market's own page flow, which already holds
 * the sim-gated, self-healing builders; the next scan sees them done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useAllMarketStats } from "@/hooks/useAllMarketStats";
import { useClaimCreatorFees } from "@/hooks/useClaimCreatorFees";
import { isMoveFlowEnabled } from "@/lib/v21/move/flag";
import { resolveV21ProgramIds, V1_PROGRAM_IDS } from "@/lib/v21/move/ids";
import { loadSuccessors } from "@/lib/v21/move/successors";
import { scanMoveInput, type V1MarketRef } from "@/lib/v21/move/scan";
import { buildMovePlan, summarizePlan, type MoveAction, type MoveInput, type MovePlan, type StepKind } from "@/lib/v21/move/plan";
import { runMove, type Executors, type RunStop } from "@/lib/v21/move/run";

export type MoveViewState = "off" | "connect" | "loading" | "ready" | "error";

const RESCAN_MS = 20_000;

/** Where a handed-off step is done (the market's own flow). */
export function stepHref(kind: StepKind, slab: string, v21Slab: string | null): string {
  if (kind === "close" || kind === "withdraw") return `/trade/${slab}`;
  if (kind === "earn-request" || kind === "earn-execute") return `/earn/${slab}`;
  if (kind === "deposit-market") return `/trade/${v21Slab ?? slab}`;
  if (kind === "deposit-earn") return `/earn/${v21Slab ?? slab}`;
  return `/my-markets`;
}

export function useMoveFlow() {
  const enabled = isMoveFlowEnabled();
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { statsMap } = useAllMarketStats({ enabled });
  const { claim } = useClaimCreatorFees();
  const [input, setInput] = useState<MoveInput | null>(null);
  const [state, setState] = useState<MoveViewState>(enabled ? "connect" : "off");
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState<RunStop | null>(null);
  const inFlight = useRef(false);

  const v21 = useMemo(() => resolveV21ProgramIds(), []);
  const successors = useMemo(() => loadSuccessors(), []);
  const refs = useMemo<V1MarketRef[]>(
    () =>
      [...statsMap.values()].flatMap((m) =>
        m.slab_address
          ? [{ slab: m.slab_address, symbol: m.symbol ?? "", mint: m.mainnet_ca ?? null, collateralDecimals: m.decimals ?? 6 }]
          : [],
      ),
    [statsMap],
  );

  const scan = useCallback(async (): Promise<MoveInput> => {
    if (!wallet.publicKey) throw new Error("no wallet");
    return scanMoveInput({ connection, wallet: wallet.publicKey, v1: V1_PROGRAM_IDS, v21, markets: refs, successors });
  }, [connection, wallet.publicKey, v21, refs, successors]);

  const rescan = useCallback(async () => {
    if (!enabled || !wallet.publicKey || refs.length === 0 || inFlight.current) return;
    inFlight.current = true;
    setState((s) => (s === "ready" ? s : "loading"));
    try {
      setInput(await scan());
      setState("ready");
    } catch {
      setState((s) => (s === "ready" ? s : "error"));
    } finally {
      inFlight.current = false;
    }
  }, [enabled, wallet.publicKey, refs.length, scan]);

  useEffect(() => {
    if (!enabled) return setState("off");
    if (!wallet.publicKey) return setState("connect");
    void rescan();
    const t = setInterval(() => void rescan(), RESCAN_MS);
    const onFocus = () => void rescan();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, wallet.publicKey, rescan]);

  const plan: MovePlan | null = useMemo(() => (input ? buildMovePlan(input) : null), [input]);

  const executors = useMemo<Executors>(
    () => ({
      "claim-creator-fee": async (a: MoveAction) => {
        const out = await claim([a.slab]);
        const o = out[0];
        if (!o?.signature) throw new Error(o?.error ?? "Claim was not confirmed");
        return o.signature;
      },
    }),
    [claim],
  );

  const run = useCallback(async () => {
    if (!enabled || running) return;
    setRunning(true);
    try {
      const r = await runMove({ scan, executors, v1Wrapper: V1_PROGRAM_IDS.wrapper, v21, maxActions: 8 });
      setStop(r.stop);
      setInput(await scan());
    } catch {
      setState("error");
    } finally {
      setRunning(false);
    }
  }, [enabled, running, scan, executors, v21]);

  return { enabled, state, plan, summary: plan ? summarizePlan(plan) : null, nowSlot: input?.nowSlot ?? null, v21Live: v21 !== null, successors, running, stop, run, rescan };
}
