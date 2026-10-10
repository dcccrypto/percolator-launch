/**
 * Orchestration of one v2.2 Earn exit, with every side effect injected (tests use fakes, the hook wires the app's
 * connection and send path).
 *
 * Contract (pinned by __tests__/lib/v22/earn-exit-run.test.ts):
 *  1. QUOTE first: plan with the stale portfolios as inline refresh accounts, SIMULATE (floor 1 atom, explicit compute
 *     budget), read the payout from the redeemer's token balance change. Nothing is sent, nothing is signed.
 *  2. 118 while quoting: re-read the stale set, re-plan, wait, simulate again (bounded), saying only "Refreshing positions…".
 *  3. The quoted minimum (quote - at most 5 bps) is shown BEFORE signing; `confirm` sends exactly that floor.
 *  4. 118 at send time: re-plan and send again inside the same action when the new floor is not below the one the user
 *     confirmed (the user's consent is "at least X"); 117 at send time: RE-QUOTE and hand the new minimum back for one confirm.
 *  5. A compute overrun is never reported as 118.
 */
import { V22_COPY } from "./copy";
import { type TransactionInstruction } from "@solana/web3.js";
import {
  COMPUTE_PRESETS_V22,
  buildRequestRedeemLpSharesIxV22,
  classifyRedemptionSimulationV22,
  computeBudgetPrelude,
  payoutFromBalancesV22,
  type EarnExitPlanV22,
  type RefreshCandidateV22,
} from "./sdk";
import { buildExitPlan, type ExitContext } from "./earn-exit";
import {
  EXIT_MAX_COMPUTE_UNITS,
  classifyExitError,
  defaultExitSleep,
  initialExitRetryState,
  nextExitStep,
  type ExitRetryState,
} from "./exit-retry";

/** How the exit is sent. `pair`: 76 + 77 in one transaction (cooldown 0). `execute`: a request already exists. `request`: 76 only (cooldown). */
export type ExitMode = "pair" | "execute" | "request";

export interface SimResult {
  err: unknown;
  logs: readonly string[];
  /** The redeemer destination token balance in the simulated post-state; null when unavailable. */
  destAfter: bigint | null;
}

export interface ExitRunDeps {
  readStale: () => Promise<RefreshCandidateV22[]>;
  /** One fresh scan, called once per 118 retry round so a portfolio that went stale after the quote is included (N3). Falls back to readStale. */
  rescanStale?: () => Promise<RefreshCandidateV22[]>;
  readDestBalance: () => Promise<bigint>;
  /** Simulate [computeBudgetPrelude(units), ...ixs] as the redeemer (use {@link withExitBudget}). Never throws for a program error: returns it in `err`. */
  simulate: (ixs: TransactionInstruction[], computeUnits: number) => Promise<SimResult>;
  /** Send [ixs] as ONE group with the explicit compute budget `computeUnits` (sendUserBundle adds the 128 KiB heap + limit). Throws the app's error shapes. */
  send: (ixs: TransactionInstruction[], computeUnits: number) => Promise<string>;
  /** Pure-parse of a thrown error (lib/limits/user-message `parseFailure`). */
  parse: (e: unknown) => { code: number | null; raw: string; logs: string[] };
  sleep?: (ms: number) => Promise<void>;
  /** "Refreshing positions…" on/off. */
  onRefreshing?: (on: boolean) => void;
}

export interface ExitQuote {
  mode: ExitMode;
  /** Simulated payout (atoms). For `request` mode: the caller-supplied estimate. */
  quote: bigint;
  /** The signed floor: quote - at most 5 bps. */
  minPayout: bigint;
  /** Stale portfolios still needing a refresh after the plan (drives the dip note). */
  staleCount: number;
  refreshSelected: number;
  refreshDeferred: number;
  computeUnits: number;
  /** True when the quote is an estimate (a request that cannot be simulated until its cooldown ends). */
  estimate: boolean;
}

export type QuoteResult =
  | { status: "quoted"; quote: ExitQuote }
  /** 118 kept coming back: wait for the next sweep (calm, not an error). */
  | { status: "wait-for-sweep"; staleCount: number }
  | { status: "failed"; error: unknown };

export type SendResult =
  | { status: "sent"; signature: string; quote: ExitQuote }
  /** 117: the price moved; here is the new minimum, confirm once more. */
  | { status: "requoted"; quote: ExitQuote }
  | { status: "wait-for-sweep"; staleCount: number }
  | { status: "failed"; error: unknown };

export interface ExitRunInput {
  ctx: ExitContext;
  mode: ExitMode;
  /** `request` mode only: the par estimate used for the floor (76 needs a non-zero floor). */
  estimateAtoms?: bigint;
}

/** `[SetComputeUnitLimit(units), RequestHeapFrame(128 KiB), ...ixs]`: the explicit budget every refreshing exit needs. */
export function withExitBudget(ixs: readonly TransactionInstruction[], units: number): TransactionInstruction[] {
  return [...computeBudgetPrelude(units), ...ixs];
}

async function simulateOnce(
  input: ExitRunInput,
  deps: ExitRunDeps,
  plan: EarnExitPlanV22,
  units: number,
): Promise<{ outcome: ReturnType<typeof classifyRedemptionSimulationV22>; payout: bigint | null }> {
  const { ctx, mode } = input;
  const before = await deps.readDestBalance();
  const req = mode === "pair" ? [buildRequestRedeemLpSharesIxV22(ctx.market, ctx.redeemer, ctx.redeemerLpAta, ctx.shares, 1n, ctx.keeperOk === true)] : [];
  const sim = await deps.simulate([...req, plan.simulationIx], units);
  const outcome = classifyRedemptionSimulationV22({ err: sim.err, logs: sim.logs });
  if (outcome.kind !== "ok") return { outcome, payout: null };
  if (sim.destAfter === null) return { outcome: { kind: "other" }, payout: null };
  try {
    return { outcome, payout: payoutFromBalancesV22(before, sim.destAfter) };
  } catch {
    return { outcome: { kind: "other" }, payout: null };
  }
}

/** Step 1 + 2: quote the exit (simulate first). Nothing is sent. */
export async function quoteExit(input: ExitRunInput, deps: ExitRunDeps): Promise<QuoteResult> {
  const sleep = deps.sleep ?? defaultExitSleep;
  const { ctx, mode } = input;
  if (mode === "request") {
    // A request cannot be simulated until its cooldown has passed: the floor rides on the 76 from the par estimate.
    const est = input.estimateAtoms ?? 0n;
    if (est <= 0n) return { status: "failed", error: new Error("no estimate for the request") };
    const plan = buildExitPlan(ctx, []);
    const f = plan.finalize(est);
    return {
      status: "quoted",
      quote: { mode, quote: est, minPayout: f.minPayoutAtoms, staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: COMPUTE_PRESETS_V22.requestRedeem.units, estimate: true },
    };
  }
  let state: ExitRetryState = initialExitRetryState();
  let units: number | null = null;
  let refreshing = false;
  const setRefreshing = (on: boolean) => {
    if (refreshing !== on) {
      refreshing = on;
      deps.onRefreshing?.(on);
    }
  };
  let rescan = false; // N3: after a 118 round the next read is ONE fresh scan, not a re-read of the old set
  try {
    for (;;) {
      const stale = ctx.boundLpPortfolio ? [] : await (rescan ? deps.rescanStale ?? deps.readStale : deps.readStale)();
      rescan = false;
      const plan = buildExitPlan(ctx, stale);
      const u = units ?? plan.computeUnits;
      const { outcome, payout } = await simulateOnce(input, deps, plan, u);
      const step = nextExitStep(state, outcome.kind === "ok" ? { kind: "ok" } : outcome.kind === "other" ? { kind: "other", error: new Error("The exit could not be priced right now. Try again shortly.") } : { kind: outcome.kind });
      if (step.action === "proceed" && payout !== null) {
        setRefreshing(false);
        const f = plan.finalize(payout);
        return {
          status: "quoted",
          quote: {
            mode,
            quote: payout,
            minPayout: f.minPayoutAtoms,
            staleCount: stale.length,
            refreshSelected: plan.refreshSelected.length,
            refreshDeferred: plan.refreshDeferred.length,
            computeUnits: u,
            estimate: false,
          },
        };
      }
      if (step.action === "refresh-and-retry") {
        setRefreshing(true);
        state = step.state;
        rescan = true;
        await sleep(step.delayMs);
        continue;
      }
      if (step.action === "requote") {
        // 117 cannot happen with a 1-atom simulation floor, but a stored floor from an earlier request can trip it.
        state = step.state;
        continue;
      }
      if (step.action === "raise-units") {
        state = step.state;
        units = EXIT_MAX_COMPUTE_UNITS;
        continue;
      }
      setRefreshing(false);
      if (step.action === "wait-for-sweep") return { status: "wait-for-sweep", staleCount: stale.length };
      if (step.action === "ask-user") {
        // F9: on a claim (execute) the floor was stored at request time and cannot be lowered: say what happened.
        return { status: "failed", error: new Error(mode === "execute" ? V22_COPY.earnExit.floorStuck : "The exit price keeps moving. Try again shortly.") };
      }
      return { status: "failed", error: step.action === "fail" ? step.error : undefined };
    }
  } finally {
    setRefreshing(false);
  }
}

function instructionsFor(input: ExitRunInput, plan: EarnExitPlanV22, quote: bigint, units: number): { ixs: TransactionInstruction[]; minPayout: bigint } {
  void units;
  const f = plan.finalize(quote);
  const body = input.mode === "pair" ? [f.requestIx, f.executeIx] : input.mode === "execute" ? [f.executeIx] : [f.requestIx];
  return { ixs: body, minPayout: f.minPayoutAtoms };
}

/**
 * Step 3: the user confirmed `confirmed` (a quote returned by {@link quoteExit}). Send exactly that floor.
 * 118 -> re-plan and resend inside this action while the new floor is not below the confirmed one;
 * 117 -> re-quote and return it for one more confirm.
 */
export async function sendExit(input: ExitRunInput, confirmed: ExitQuote, deps: ExitRunDeps): Promise<SendResult> {
  const sleep = deps.sleep ?? defaultExitSleep;
  let state: ExitRetryState = initialExitRetryState();
  let units = confirmed.computeUnits;
  let current = confirmed;
  let stale = confirmed.mode === "request" || input.ctx.boundLpPortfolio ? [] : await deps.readStale();
  let refreshing = false;
  const setRefreshing = (on: boolean) => {
    if (refreshing !== on) {
      refreshing = on;
      deps.onRefreshing?.(on);
    }
  };
  try {
    for (;;) {
      const plan = buildExitPlan(input.ctx, stale);
      // The program ALSO enforces the stored floor; we send the floor the user saw (the confirmed quote's floor).
      const { ixs } = instructionsFor(input, plan, confirmed.quote, units);
      try {
        const signature = await deps.send(ixs, units);
        setRefreshing(false);
        return { status: "sent", signature, quote: current };
      } catch (e) {
        const outcome = classifyExitError(e, deps.parse);
        const step = nextExitStep(state, outcome);
        if (step.action === "refresh-and-retry") {
          setRefreshing(true);
          state = step.state;
          await sleep(step.delayMs);
          stale = await (deps.rescanStale ?? deps.readStale)();
          continue;
        }
        if (step.action === "raise-units") {
          state = step.state;
          units = EXIT_MAX_COMPUTE_UNITS;
          continue;
        }
        setRefreshing(false);
        if (step.action === "requote" || step.action === "ask-user") {
          const q = await quoteExit(input, deps);
          if (q.status === "quoted") return { status: "requoted", quote: q.quote };
          if (q.status === "wait-for-sweep") return q;
          return { status: "failed", error: q.error };
        }
        if (step.action === "wait-for-sweep") return { status: "wait-for-sweep", staleCount: stale.length };
        return { status: "failed", error: step.action === "fail" ? step.error ?? e : e };
      }
    }
  } finally {
    setRefreshing(false);
  }
}

