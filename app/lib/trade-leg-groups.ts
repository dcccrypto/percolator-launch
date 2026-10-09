/**
 * M-2 (code-review-live-paths-2026-10-01): a multi-leg trade (a "Close 100%"
 * over the matcher's per-fill cap) used to put EVERY leg in one transaction.
 * One TradeCpi leg costs roughly 260k–420k CU (2 legs measured 519k–733k), and
 * a transaction is capped at 1.4M, so 4 legs could never fit: the close failed
 * simulation with an unmapped message.
 *
 * This module packs the legs into as many transactions as the CU budget needs:
 *   1. plan: all legs in one transaction first (or `initialPerTx`);
 *   2. simulate EVERY transaction before anything is signed. A transaction that
 *      runs out of compute (or simulates above the budget) re-plans with one leg
 *      fewer per transaction, down to 1. Any other refusal throws a
 *      SimulationRefusal, so the wallet never opens;
 *   3. sign all of them with ONE approval (signAllCompat), then broadcast in
 *      order, each confirmed before the next. Each leg is a partial reduction of
 *      the same position, so every transaction is valid on its own against the
 *      state before or after the earlier ones land.
 * If a later transaction fails after an earlier one landed, PartialLegSendError
 * carries what landed so the caller can say "part of it closed".
 */
import type { Transaction, TransactionInstruction } from "@solana/web3.js";
import { MAX_TX_COMPUTE_UNITS, sizeComputeUnitLimit } from "@/lib/compute-budget";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { BATCH_MAX_LEGS_V22, assertBatchLegsV22 } from "@/lib/v22/sdk";

/** Conservative per-leg CU estimate for planning (measured ≤ ~420k incl. settlement). */
export const CU_PER_TRADE_LEG_ESTIMATE = 420_000;
/** CU kept free for the compute-budget prefix, the crank prepend and margin. */
export const CU_TX_RESERVE = 140_000;

/** Legs that always fit one transaction (2 legs measured ≤ 733k CU): the single-tx path. */
export const SINGLE_TX_MAX_LEGS = 2;

/**
 * Most trade legs one transaction may carry. v2.2 (flag on): 4 (percolator-prog#546: `MATCHER_BATCH_MAX_LEGS` = 4, measured 689,000 CU for
 * a 4-leg batch; the portfolio itself holds at most 4 legs). Flag off: unbounded here (the simulation decides, as before).
 */
export function maxLegsPerTx(): number {
  return isDevnetV22Enabled() ? BATCH_MAX_LEGS_V22 : Number.POSITIVE_INFINITY;
}

/** Static plan bound: legs that fit one transaction by the estimate (≥ 1). */
export function legsPerTxForBudget(
  perLeg: number = CU_PER_TRADE_LEG_ESTIMATE,
  reserve: number = CU_TX_RESERVE,
  maxTx: number = MAX_TX_COMPUTE_UNITS,
): number {
  return Math.max(1, Math.floor((maxTx - reserve) / perLeg));
}

/** Split legs (order kept) into groups of at most `perTx`. Every leg appears exactly once. */
export function groupLegs<T>(legs: readonly T[], perTx: number): T[][] {
  const n = Math.max(1, Math.floor(perTx));
  const out: T[][] = [];
  for (let i = 0; i < legs.length; i += n) out.push(legs.slice(i, i + n));
  return out;
}

export interface LegGroupSimulation {
  consumed: number | null;
  err: unknown;
  logs: string[];
  rpcFailed: boolean;
  simulated: TransactionInstruction[];
}

/** A simulation verdict that means "this transaction needs more compute than it was given". */
export function isComputeExhausted(sim: Pick<LegGroupSimulation, "err" | "logs" | "consumed">): boolean {
  const e = JSON.stringify(sim.err ?? "");
  if (/ComputationalBudgetExceeded|ProgramFailedToComplete/i.test(e)) return true;
  if (sim.logs.some((l) => /exceeded CUs meter|computational budget exceeded/i.test(l))) return true;
  return false;
}

export class PartialLegSendError extends Error {
  readonly landedSignatures: string[];
  readonly landedLegs: number;
  readonly totalLegs: number;
  readonly cause?: unknown;
  constructor(landedSignatures: string[], landedLegs: number, totalLegs: number, cause: unknown) {
    super(
      `Part of this order went through (${landedLegs} of ${totalLegs} parts). ` +
        "The rest didn't — your position shows what's open now; you can close the remainder again.",
    );
    this.name = "PartialLegSendError";
    this.landedSignatures = landedSignatures;
    this.landedLegs = landedLegs;
    this.totalLegs = totalLegs;
    this.cause = cause;
  }
}

export interface SendLegGroupsDeps {
  simulate: (ixs: TransactionInstruction[]) => Promise<LegGroupSimulation>;
  /** Wrap a simulation error that is a real refusal (never opens the wallet). */
  refusal: (sim: LegGroupSimulation) => Error;
  buildTx: (ixs: TransactionInstruction[], computeUnits: number) => Transaction;
  signAll: (txs: Transaction[]) => Promise<Transaction[]>;
  broadcast: (tx: Transaction) => Promise<string>;
}

export interface SendLegGroupsParams<L> {
  legs: readonly L[];
  /** Instructions for one transaction carrying `group` (the first group may add a crank). */
  buildGroupIxs: (group: L[], index: number) => TransactionInstruction[];
  /** Initial legs-per-transaction bound (default: all legs; the simulation lowers it). */
  initialPerTx?: number;
}

export interface SendLegGroupsResult {
  signatures: string[];
  perTx: number;
  groups: number;
}

/** Plan + simulate every group; re-plan on compute exhaustion. Returns the ixs and CU limits to sign. */
export async function planLegGroups<L>(
  p: SendLegGroupsParams<L>,
  deps: Pick<SendLegGroupsDeps, "simulate" | "refusal">,
): Promise<{ perTx: number; groups: L[][]; ixs: TransactionInstruction[][]; units: number[] }> {
  // Start from ALL legs in one tx (4 legs measured ≤1.16M CU on devnet, #2731) and let the
  // simulation decide: compute exhaustion drops one leg per tx and re-plans.
  let perTx = Math.max(1, Math.min(p.initialPerTx ?? p.legs.length, p.legs.length || 1, maxLegsPerTx()));
  for (;;) {
    const groups = groupLegs(p.legs, perTx);
    if (isDevnetV22Enabled()) for (const g of groups) assertBatchLegsV22(g.length);
    const ixs = groups.map((g, i) => p.buildGroupIxs(g, i));
    const sims = await Promise.all(ixs.map((x) => deps.simulate(x)));
    let replan = false;
    const units: number[] = [];
    for (let i = 0; i < sims.length; i++) {
      const sim = sims[i];
      const legsHere = groups[i].length;
      const tooBig =
        isComputeExhausted(sim) ||
        // The split decision uses the TIGHT estimate (+15% / 5k): a group that needs <1.4M
        // stays one tx; its signed limit still gets the full headroom, clamped to 1.4M.
        (sim.consumed !== null &&
          sizeComputeUnitLimit(sim.consumed, { cap: MAX_TX_COMPUTE_UNITS, marginBps: 1_500, padUnits: 5_000 }) >= MAX_TX_COMPUTE_UNITS);
      if (tooBig && legsHere > 1) {
        replan = true;
        break;
      }
      if (sim.err) throw deps.refusal(sim);
      // RPC failure: no verdict — size from the estimate; the broadcast preflight still guards.
      units.push(
        sizeComputeUnitLimit(sim.consumed, {
          cap: Math.min(MAX_TX_COMPUTE_UNITS, CU_TX_RESERVE + CU_PER_TRADE_LEG_ESTIMATE * legsHere),
        }),
      );
    }
    if (!replan) return { perTx, groups, ixs, units };
    perTx -= 1;
  }
}

/** Plan, simulate, sign once, broadcast in order. */
export async function sendLegGroups<L>(p: SendLegGroupsParams<L>, deps: SendLegGroupsDeps): Promise<SendLegGroupsResult> {
  const plan = await planLegGroups(p, deps);
  const txs = plan.ixs.map((ixs, i) => deps.buildTx(ixs, plan.units[i]));
  const signed = await deps.signAll(txs);
  const signatures: string[] = [];
  let landedLegs = 0;
  for (let i = 0; i < signed.length; i++) {
    try {
      signatures.push(await deps.broadcast(signed[i]));
      landedLegs += plan.groups[i].length;
    } catch (e) {
      if (i === 0) throw e; // nothing landed: the plain failure path
      throw new PartialLegSendError(signatures, landedLegs, p.legs.length, e);
    }
  }
  return { signatures, perTx: plan.perTx, groups: plan.groups.length };
}


export function isPartialLegSendError(e: unknown): e is PartialLegSendError {
  return e instanceof PartialLegSendError || (e instanceof Error && e.name === "PartialLegSendError");
}
