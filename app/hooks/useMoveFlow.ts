"use client";

/**
 * Move-to-v2.1 orchestration hook. Scans the wallet's v1 footprint, derives the plan from chain
 * state alone (resume = scan again; nothing correctness-critical lives in localStorage), and runs
 * every step except the v2.1 deposits in place: creator-fee claims reuse useClaimCreatorFees; close,
 * withdraw and Earn request / collect mount a headless per-market host (components/move/
 * MarketExecutorHost) that exposes the existing sim-gated builders as a MarketBridge. Each run
 * re-scans after every confirmation, so it is resumable from any state.
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
import { makeMarketExecutors, type MarketBridge } from "@/lib/v21/move/market-exec";
import { safeUserMessage } from "@/lib/v21/move/errors";

export type MoveViewState = "off" | "connect" | "loading" | "ready" | "error";

const RESCAN_MS = 20_000;

/** Where a handed-off step is done (the market's own flow). */
export function stepHref(kind: StepKind, slab: string, v21Slab: string | null, handoff?: "earn" | "market"): string {
  if (kind === "close" || kind === "withdraw") return `/trade/${slab}`;
  if (kind === "settle-resolved") return handoff === "market" ? `/trade/${slab}` : `/earn/${slab}`;
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
  const [hostSlab, setHostSlab] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const bridgeRef = useRef<MarketBridge | null>(null);
  const onBridge = useCallback((b: MarketBridge | null) => {
    bridgeRef.current = b;
  }, []);
  const bridgeFor = useCallback(async (slab: string): Promise<MarketBridge> => {
    setHostSlab(slab);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const b = bridgeRef.current;
      if (b && b.slab === slab && b.ready) return b;
      if (Date.now() > deadline) throw new Error("Move: market not loaded");
      await new Promise((r) => setTimeout(r, 250));
    }
  }, []);

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
      ...makeMarketExecutors(bridgeFor),
      "claim-creator-fee": async (a: MoveAction) => {
        const out = await claim([a.slab]);
        const o = out[0];
        if (!o?.signature) throw new Error(o?.error ?? "Claim was not confirmed");
        return o.signature;
      },
    }),
    [claim, bridgeFor],
  );

  const run = useCallback(async (only?: { slab: string; kind: StepKind }) => {
    if (!enabled || running) return;
    setRunning(true);
    setLastError(null);
    try {
      const r = await runMove({
        scan,
        executors,
        v1Wrapper: V1_PROGRAM_IDS.wrapper,
        v21,
        maxActions: 8,
        only: only ? (a) => a.slab === only.slab && a.kinds[0] === only.kind : undefined,
      });
      setStop(r.stop);
      if (r.stop.reason === "error") setLastError(safeUserMessage(r.stop.error));
      setInput(await scan());
    } catch {
      setState("error");
    } finally {
      setRunning(false);
    }
  }, [enabled, running, scan, executors, v21]);

  return { enabled, state, plan, summary: plan ? summarizePlan(plan) : null, nowSlot: input?.nowSlot ?? null, v21Live: v21 !== null, successors, running, stop, run, rescan, hostSlab, onBridge, lastError };
}
