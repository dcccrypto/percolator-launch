'use client';

/**
 * Earn senior exit after a market resolves (P3 / F-4): reads the market, its LP-vault registry,
 * the vault-LP state and every portfolio on the market, plans the terminal sweep
 * (lib/limits/resolved-exit.ts) and executes it with the connected wallet as the fee payer
 * (lib/limits/resolved-exit-run.ts). Once the market is terminal-flat the ordinary Earn
 * redemption (76 -> 77) pays out.
 *
 * Reads only while the market is RESOLVED; on a live market the hook is inert (one market read).
 */
import { errorText } from "@/lib/error-text";
import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  deriveInsuranceLpMint,
  deriveLpEscrow,
  deriveLpRedemption,
  deriveLpVaultRegistry,
} from '@percolatorct/sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { broadcastSignedTx, getFreshBlockhash, getPriorityFee, sendTx, signAllCompat } from '@/lib/tx';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { computeBudgetPrefix, connectionSelfHealDeps } from '@/lib/self-heal';
import { EXIT_TX_CU_CAP, type ResolvedExitPlan } from '@/lib/limits/resolved-exit';
import { loadResolvedExitSnapshot, type ResolvedExitSnapshot } from '@/lib/limits/resolved-exit-load';
import { viewerOwnedKeys, viewerReceiptStatus, type ViewerReceipt } from '@/lib/limits/resolved-topup';
import { exitStepIxs, type ExitIxContext } from '@/lib/limits/resolved-exit-ixs';
import { runResolvedExit, type ResolvedExitRun } from '@/lib/limits/resolved-exit-run';
import { buildRequestRedeemIx } from '@/lib/limits/earn-ixs';
import {
  buildFinishList,
  FINISH_MAX_TXS,
  finishEstimate,
  finishItemCu,
  buildFinishTxs,
  planPortfolios,
  pruneRefusedItems,
  runFinish,
  stepNeeded,
  type FinishItem,
  type FinishRun,
} from '@/lib/limits/resolved-finish';

/**
 * Simulation budget for an exit tx. The SEND budget is per tx, the sum of its steps' measured
 * costs (lib/limits/resolved-exit.ts EXIT_STEP_CU: 101 up to 285k, CloseResolved up to 204k on the
 * final wrapper); a bare simulation gets the 200k per-instruction default and would read a 285k
 * step as refused, so the simulation runs at the tx cap.
 */
export const EXIT_TX_CU = EXIT_TX_CU_CAP;

/** While settled but not yet payable, re-read so the panel flips to Ready when the keeper finishes. */
export const RESOLVED_POLL_MS = 20_000;

type Snapshot = ResolvedExitSnapshot;

export interface ResolvedExitState {
  resolved: boolean;
  plan: ResolvedExitPlan | null;
  /** Chain slot of the last read (for the ETA; never shown). */
  nowSlot: bigint | null;
  /** What "Finish now" would do right now (null when there is nothing to finish). */
  estimate: { steps: number; sol: string } | null;
  running: boolean;
  lastRun: ResolvedExitRun | null;
  lastFinish: FinishRun | null;
  error: string | null;
  /** The viewer's own resolved payout is partial (the rest via tag 46 once 101 has closed). */
  viewerReceipt: ViewerReceipt;
}

/** The Earn request (76) the user's "Finish now and request my withdrawal" appends. */
export interface FinishEarnRequest {
  shares: bigint;
}

export function useResolvedExit(slabAddress: string | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, config } = useSlabState();
  const [state, setState] = useState<ResolvedExitState>({
    resolved: false,
    plan: null,
    nowSlot: null,
    estimate: null,
    running: false,
    lastRun: null,
    lastFinish: null,
    error: null,
    viewerReceipt: 'none',
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const snapshot = useCallback(async (): Promise<Snapshot | null> => {
    if (!slabAddress || !programId || !config) return null;
    return loadResolvedExitSnapshot({
      connection,
      programId: new PublicKey(programId),
      market: new PublicKey(slabAddress),
      collateralMint: config.collateralMint,
      payer: wallet.publicKey ?? null,
    });
  }, [connection, slabAddress, programId, config, wallet.publicKey]);

  const refresh = useCallback(async () => {
    try {
      const s = await snapshot();
      if (!alive.current) return;
      setState((p) => ({
        ...p,
        resolved: !!s && s.plan.phase !== 'not-resolved',
        plan: s?.plan ?? null,
        nowSlot: s ? s.nowSlot : null,
        estimate: s ? estimateOf(s, wallet.publicKey ?? null) : null,
        viewerReceipt: s ? viewerReceiptStatus(s.plan, s.portfolios, wallet.publicKey ?? null) : 'none',
        error: null,
      }));
    } catch (e) {
      if (alive.current) setState((p) => ({ ...p, error: errorText(e) }));
    }
  }, [snapshot, wallet.publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keeper-first (audit §3.9): poll only while settled and not yet payable, so the panel turns
  // to "withdraw now" on its own. A live market is never polled.
  const settling = state.resolved && state.plan !== null && state.plan.phase !== 'ready';
  useEffect(() => {
    if (!settling) return;
    return pollWhenVisible(() => void refresh(), RESOLVED_POLL_MS);
  }, [settling, refresh]);

  const run = useCallback(async (): Promise<ResolvedExitRun | null> => {
    if (!wallet.publicKey || !slabAddress) throw new Error('Wallet not connected');
    const market = new PublicKey(slabAddress);
    const payer = wallet.publicKey;
    setState((p) => ({ ...p, running: true, error: null }));
    let ctx: ExitIxContext | null = null;
    try {
      const sim = connectionSelfHealDeps(connection, market, payer);
      const result = await runResolvedExit({
        plan: async () => {
          const s = await snapshot();
          ctx = s?.ctx ?? null;
          return s?.plan ?? { phase: 'not-resolved' };
        },
        ixsFor: (step) => {
          if (!ctx) throw new Error('market not loaded');
          return exitStepIxs(step, ctx);
        },
        simulate: async (ixs) => (await sim.simulate([...computeBudgetPrefix(EXIT_TX_CU), ...ixs])).err ?? null,
        send: (ixs, computeUnits) => sendTx({ connection, wallet, instructions: ixs, computeUnits }),
      });
      if (alive.current) setState((p) => ({ ...p, running: false, lastRun: result, plan: result.final }));
      return result;
    } catch (e) {
      if (alive.current) setState((p) => ({ ...p, running: false, error: errorText(e) }));
      throw e;
    }
  }, [connection, wallet, slabAddress, snapshot]);

  /**
   * "Finish now" in ONE approval (audit §3.9): every step that can finish the market, repeatable
   * steps pre-signed in copies, optionally the user's own Earn request (76) last. Steps refused in
   * simulation are dropped (with their portfolio's later steps) BEFORE the wallet opens; copies
   * that turn out unneeded are never broadcast. What a stale list leaves, the keeper finishes.
   */
  const finish = useCallback(
    async (earn?: FinishEarnRequest): Promise<FinishRun | null> => {
      if (!wallet.publicKey || !slabAddress || !programId) throw new Error('Wallet not connected');
      const market = new PublicKey(slabAddress);
      const payer = wallet.publicKey;
      const prog = new PublicKey(programId);
      setState((p) => ({ ...p, running: true, error: null }));
      try {
        const s = await snapshot();
        if (!s || !s.ctx || s.plan.phase === 'not-resolved') throw new Error('market not loaded');
        const ctx: ExitIxContext = { ...s.ctx, payer };
        const withEarnRequest = !!earn && earn.shares > 0n;
        let items = buildFinishList({
          portfolios: s.portfolios,
          boundVault: s.bound,
          withEarnRequest,
          only: s.plan.phase === 'owner-window' ? planPortfolios(s.plan) : undefined,
          viewerOwned: viewerOwnedKeys(s.portfolios, payer),
        });
        // Split BEFORE signing: simulate what can run now; a refused step drops its whole chain.
        const sim = connectionSelfHealDeps(connection, market, payer);
        // Only the FIRST item of each step runs against today's state (later copies depend on the
        // items before them); pruneRefusedItems keeps a refused 46's later copy (lib/limits/resolved-finish).
        const refused: FinishItem[] = [];
        const tried = new Set<string>();
        for (const it of items) {
          if (it.step.kind === 'earn-request' || !stepNeeded(it, s.plan)) continue;
          const k = JSON.stringify(it.step);
          if (tried.has(k)) continue;
          tried.add(k);
          const err = (await sim.simulate([...computeBudgetPrefix(finishItemCu(it)), ...exitStepIxs(it.step, ctx)])).err ?? null;
          if (err) refused.push(it);
        }
        items = pruneRefusedItems(items, refused).slice(0, FINISH_MAX_TXS);
        let request: TransactionInstruction | null = null;
        if (withEarnRequest && earn) {
          const [registry] = deriveLpVaultRegistry(prog, market);
          const [lpMint] = deriveInsuranceLpMint(prog, market);
          request = buildRequestRedeemIx({
            programId: prog,
            redeemer: payer,
            registry,
            lpMint,
            redeemerLpAta: getAssociatedTokenAddressSync(lpMint, payer),
            escrow: deriveLpEscrow(prog, market)[0],
            redemption: deriveLpRedemption(prog, registry, payer)[0],
            shares: earn.shares,
          });
        }
        if (items.length === 0) throw new Error('nothing to finish');
        const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
        const txs = buildFinishTxs(items, ctx, request, { blockhash, priorityFeeMicroLamports: fee, feePayer: payer });
        const signed = await signAllCompat(wallet, txs);
        const result = await runFinish(
          items.map((item: FinishItem, i) => ({ item, tx: signed[i]! })),
          {
            plan: async () => (await snapshot())?.plan ?? { phase: 'not-resolved' },
            broadcast: (tx) => broadcastSignedTx(connection, tx),
          },
        );
        if (alive.current) setState((p) => ({ ...p, running: false, lastFinish: result, plan: result.final }));
        void refresh();
        return result;
      } catch (e) {
        if (alive.current) setState((p) => ({ ...p, running: false, error: errorText(e) }));
        throw e;
      }
    },
    [connection, wallet, slabAddress, programId, snapshot, refresh],
  );

  return { ...state, refresh, run, finish };
}

/** The finish estimate for a snapshot (null when nothing can run now). */
function estimateOf(s: Snapshot, viewer: PublicKey | null): { steps: number; sol: string } | null {
  if (s.plan.phase !== 'sweep' && s.plan.phase !== 'owner-window') return null;
  if (s.plan.steps.length === 0) return null;
  const items = buildFinishList({
    portfolios: s.portfolios,
    boundVault: s.bound,
    withEarnRequest: false,
    only: s.plan.phase === 'owner-window' ? planPortfolios(s.plan) : undefined,
    viewerOwned: viewerOwnedKeys(s.portfolios, viewer),
  }).slice(0, FINISH_MAX_TXS);
  return items.length ? finishEstimate(items) : null;
}
