/**
 * Pure bounded retry machine for a v2.2 Earn exit (tag 77), modelled on lib/v21/loss-stale-retry.ts.
 *
 * One user action may need several attempts, none of which asks anything of the user:
 *  - 118 ExitRequiresLossCurrent  -> re-read the stale portfolios, re-plan with them as inline refresh accounts, wait a
 *    moment, simulate again (bounded: {@link EXIT_REFRESH_DELAYS_MS}); after the last attempt the calm "wait for the next
 *    sweep" outcome (never a red error).
 *  - 117 RedemptionBelowMinPayout -> RE-QUOTE: simulate again and hand the new minimum back for one confirm.
 *  - a compute overrun is NOT a program error and is NEVER treated as 118: raise the unit limit once, then fail.
 *  - anything else passes through untouched.
 */
import { WRAPPER_ERR_V22 } from "./wrapper-errors";

/** ~1 s apart, 3 attempts after the first (about 4.5 s in total), then the calm wait line. */
export const EXIT_REFRESH_DELAYS_MS: readonly number[] = [1_000, 1_500, 2_000];
/** One automatic re-quote per action; a second 117 in a row is handed to the user (the book is moving). */
export const EXIT_MAX_REQUOTES = 2;
/** Hard ceiling (the transaction limit). */
export const EXIT_MAX_COMPUTE_UNITS = 1_400_000;

export type ExitAttemptOutcome =
  | { kind: "ok" }
  | { kind: "notLossCurrent" }
  | { kind: "belowMinPayout" }
  | { kind: "computeBudgetExceeded" }
  | { kind: "other"; error?: unknown };

export interface ExitRetryState {
  refreshAttempts: number;
  requotes: number;
  unitsRaised: boolean;
}

export const initialExitRetryState = (): ExitRetryState => ({ refreshAttempts: 0, requotes: 0, unitsRaised: false });

export type ExitStep =
  | { action: "proceed" }
  | { action: "refresh-and-retry"; delayMs: number; state: ExitRetryState }
  | { action: "requote"; state: ExitRetryState }
  | { action: "raise-units"; state: ExitRetryState }
  /** 118 persisted: say "wait for the next sweep" (and offer keeper_ok). Not an error. */
  | { action: "wait-for-sweep" }
  /** 117 kept recurring: hand the latest quote to the user. */
  | { action: "ask-user" }
  | { action: "fail"; error?: unknown };

/** What to do after one attempt (simulation or send) ended with `outcome`. */
export function nextExitStep(state: ExitRetryState, outcome: ExitAttemptOutcome, delays: readonly number[] = EXIT_REFRESH_DELAYS_MS): ExitStep {
  switch (outcome.kind) {
    case "ok":
      return { action: "proceed" };
    case "notLossCurrent":
      if (state.refreshAttempts >= delays.length) return { action: "wait-for-sweep" };
      return { action: "refresh-and-retry", delayMs: delays[state.refreshAttempts], state: { ...state, refreshAttempts: state.refreshAttempts + 1 } };
    case "belowMinPayout":
      if (state.requotes >= EXIT_MAX_REQUOTES) return { action: "ask-user" };
      return { action: "requote", state: { ...state, requotes: state.requotes + 1 } };
    case "computeBudgetExceeded":
      // Never 118: a CU overrun aborts the transaction and is not a program error. Raise the limit once.
      if (state.unitsRaised) return { action: "fail", error: new Error("The exit needs more compute than one transaction allows. Try a smaller amount.") };
      return { action: "raise-units", state: { ...state, unitsRaised: true } };
    case "other":
      return { action: "fail", error: outcome.error };
  }
}

/** Classify a thrown error from a send (or a simulation refusal) the same way the simulation classifier does. */
export function classifyExitError(err: unknown, parse: (e: unknown) => { code: number | null; raw: string; logs: string[] }): ExitAttemptOutcome {
  const p = parse(err);
  const text = [p.raw, ...p.logs].join("\n");
  if (/exceeded CUs meter|ComputationalBudgetExceeded|exceeded maximum number of instructions/i.test(text)) return { kind: "computeBudgetExceeded" };
  if (p.code === WRAPPER_ERR_V22.ExitRequiresLossCurrent) return { kind: "notLossCurrent" };
  if (p.code === WRAPPER_ERR_V22.RedemptionBelowMinPayout) return { kind: "belowMinPayout" };
  return { kind: "other", error: err };
}

export const defaultExitSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
