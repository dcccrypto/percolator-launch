/**
 * Orchestration of one v2.2 Earn exit, with every side effect injected (tests use fakes, the hook wires the app's
 * connection and send path).
 *
 * Contract (pinned by __tests__/lib/v22/earn-exit-run.test.ts):
 *  1. QUOTE first: plan with the stale portfolios as inline refresh accounts, SIMULATE (floor 1 atom, explicit compute
 *     budget), read the payout from the redeemer's token balance change. Nothing is sent, nothing is signed.
 *  2. 118 while quoting: re-read the stale set, re-plan, wait, simulate again (bounded), saying only "Refreshing positions…".
 *  3. The quoted minimum (quote - at most 5 bps; a cooldown `request`: 10% under the estimate, #3600) is shown BEFORE
 *     signing; `confirm` sends exactly that floor.
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
import { earnRequestFloorAtoms } from "@/lib/limits/earn-ixs";
import {
  EXIT_LINES,
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
  /**
   * The redeemer destination's balance BEFORE the exit (the payout is the change). A missing account resolves 0n; a read
   * that failed must REJECT (#3612): counted as 0 it would make the wallet's whole balance part of the quote and floor.
   */
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
  /**
   * v2.2 QA E-1: tag 78 LpVaultCrankFees for this BOUND vault (tail-aware: vault-LP state, ext, LP, bond tranche), or
   * null when the vault is not bound. A bound vault's 77 refuses 84 VaultLpHarvestPending while LP fees are
   * harvestable, and 78 must ride in front IN THE SAME TX. 78 is permissionless but NOT a no-op: with nothing to harvest
   * it refuses 38 LpVaultNoFeesToCrank (wrapper RC 6c078a0e handle_lp_vault_crank_fees), so it is added only on an 84.
   */
  harvestIx?: () => Promise<TransactionInstruction | null>;
}

/** 84 VaultLpHarvestPending: 77 on a bound vault with harvestable LP fees. */
export const ERR_HARVEST_PENDING = 84;
/** 38 LpVaultNoFeesToCrank: a 78 with nothing to harvest (someone else harvested first). */
export const ERR_NO_FEES_TO_CRANK = 38;

export interface ExitQuote {
  mode: ExitMode;
  /** Simulated payout (atoms). For `request` mode: the caller-supplied estimate. */
  quote: bigint;
  /** The signed floor: quote - at most 5 bps (`request`: EARN_REQUEST_FLOOR_BPS under the estimate). */
  minPayout: bigint;
  /** Stale portfolios still needing a refresh after the plan (drives the dip note). */
  staleCount: number;
  refreshSelected: number;
  refreshDeferred: number;
  computeUnits: number;
  /** True when the quote is an estimate (a request that cannot be simulated until its cooldown ends). */
  estimate: boolean;
  /** E-1: the quote was simulated with tag 78 in front (the send carries it too). */
  harvest?: boolean;
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

/**
 * #3605: a simulated refusal as the user-message mapper reads it (`parseFailure`: name SimulationRefusal + code, the
 * failing program from the logs), with the plain line as its message for a code the mapper has no copy for.
 */
function unpricedRefusal(code: number | undefined, logs: readonly string[]): Error {
  return Object.assign(new Error(EXIT_LINES.unpriced), { name: "SimulationRefusal", code: code ?? null, logs: [...logs] });
}

/** #3612: the "before" balance could not be read; the quote fails with {@link EXIT_LINES.balanceUnread}. */
class BalanceUnreadError extends Error {
  constructor() {
    super(EXIT_LINES.balanceUnread);
    this.name = "BalanceUnreadError";
  }
}

async function simulateOnce(
  input: ExitRunInput,
  deps: ExitRunDeps,
  plan: EarnExitPlanV22,
  units: number,
  prefix: readonly TransactionInstruction[] = [],
): Promise<{ outcome: ReturnType<typeof classifyRedemptionSimulationV22>; payout: bigint | null; logs?: readonly string[] }> {
  const { ctx, mode } = input;
  let before: bigint;
  try {
    before = await deps.readDestBalance();
  } catch {
    // Never the RPC text (an RPC URL can carry an API key) and never 0 (#3612).
    throw new BalanceUnreadError();
  }
  const req = mode === "pair" ? [buildRequestRedeemLpSharesIxV22(ctx.market, ctx.redeemer, ctx.redeemerLpAta, ctx.shares, 1n, ctx.keeperOk === true)] : [];
  const sim = await deps.simulate([...prefix, ...req, plan.simulationIx], units);
  const outcome = classifyRedemptionSimulationV22({ err: sim.err, logs: sim.logs });
  if (outcome.kind !== "ok") return { outcome, payout: null, logs: sim.logs };
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
    if (est <= 0n) return { status: "failed", error: new Error(EXIT_LINES.unpriced) };
    return {
      status: "quoted",
      quote: { mode, quote: est, minPayout: earnRequestFloorAtoms(est), staleCount: 0, refreshSelected: 0, refreshDeferred: 0, computeUnits: COMPUTE_PRESETS_V22.requestRedeem.units, estimate: true },
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
  let harvest: TransactionInstruction | null = null; // E-1: tag 78 in front once a simulation said 84
  let harvestTried = false;
  try {
    for (;;) {
      const stale = ctx.boundLpPortfolio ? [] : await (rescan ? deps.rescanStale ?? deps.readStale : deps.readStale)();
      rescan = false;
      const plan = buildExitPlan(ctx, stale);
      const u = units ?? plan.computeUnits;
      const { outcome, payout, logs } = await simulateOnce(input, deps, plan, u, harvest ? [harvest] : []);
      if (!harvestTried && outcome.kind === "other" && outcome.code === ERR_HARVEST_PENDING && !harvest && deps.harvestIx) {
        harvestTried = true;
        harvest = await deps.harvestIx();
        if (harvest) continue;
      }
      if (outcome.kind === "other" && outcome.code === ERR_NO_FEES_TO_CRANK && harvest) {
        harvest = null; // harvested by someone else since: 77 alone again (an 84 now would not re-add it)
        continue;
      }
      const step = nextExitStep(state, outcome.kind === "ok" ? { kind: "ok" } : outcome.kind === "other" ? { kind: "other", error: unpricedRefusal(outcome.code, logs ?? []) } : { kind: outcome.kind });
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
            ...(harvest ? { harvest: true } : {}),
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
        return { status: "failed", error: new Error(mode === "execute" ? V22_COPY.earnExit.floorStuck : EXIT_LINES.moving) };
      }
      return { status: "failed", error: step.action === "fail" ? step.error : undefined };
    }
  } catch (e) {
    if (e instanceof BalanceUnreadError) return { status: "failed", error: new Error(EXIT_LINES.balanceUnread) };
    throw e;
  } finally {
    setRefreshing(false);
  }
}

/**
 * #3600: a request's floor is STORED and binds every later 77 (the program pays `max(wire, stored)`), after a cooldown
 * nobody can simulate across. 5 bps under the par estimate turned ordinary NAV drift into a 117 on every collect, so a
 * request takes the flag-off floor (EARN_REQUEST_FLOOR_BPS, 10%, AUD-S1-18 / #3582). `pair` and `execute` keep the SDK's
 * 5 bps: their floor comes from a simulation of the same transaction.
 */
function instructionsFor(input: ExitRunInput, plan: EarnExitPlanV22, quote: bigint, units: number): { ixs: TransactionInstruction[]; minPayout: bigint } {
  void units;
  if (input.mode === "request") {
    // Built here, not by plan.finalize: the SDK's floor helper refuses anything wider than 5 bps.
    const { ctx } = input;
    const minPayout = earnRequestFloorAtoms(quote);
    return { ixs: [buildRequestRedeemLpSharesIxV22(ctx.market, ctx.redeemer, ctx.redeemerLpAta, ctx.shares, minPayout, ctx.keeperOk === true)], minPayout };
  }
  const f = plan.finalize(quote);
  const body = input.mode === "pair" ? [f.requestIx, f.executeIx] : [f.executeIx];
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
  // E-1: 78 rides in front when the quote needed it; an 84 at send time adds it once, a 38 (already harvested) drops it once.
  let harvest: TransactionInstruction | null = confirmed.harvest && deps.harvestIx ? await deps.harvestIx() : null;
  let harvestToggled = false;
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
      const { ixs: body } = instructionsFor(input, plan, confirmed.quote, units);
      const ixs = harvest ? [harvest, ...body] : body;
      try {
        const signature = await deps.send(ixs, units);
        setRefreshing(false);
        return { status: "sent", signature, quote: current };
      } catch (e) {
        if (!harvestToggled && input.mode !== "request") {
          const code = deps.parse(e).code;
          if (code === ERR_HARVEST_PENDING && !harvest && deps.harvestIx) {
            harvestToggled = true;
            harvest = await deps.harvestIx();
            if (harvest) continue;
          } else if (code === ERR_NO_FEES_TO_CRANK && harvest) {
            harvestToggled = true;
            harvest = null;
            continue;
          }
        }
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

