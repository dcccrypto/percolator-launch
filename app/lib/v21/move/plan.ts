/**
 * The Move plan: a pure function of a chain snapshot -> ordered, idempotent steps per v1 market.
 * Nothing here talks to the chain or builds an instruction. Re-derive after every confirmation:
 * a step already done reads "done", so resuming (same tab, next day, other device) is just
 * "scan again, plan again".
 *
 * Rules (the guards the tests pin, each with a negative control):
 *  - close: never blocked (close-only, locked, stale: closing is always allowed on v1). No tag 103/104
 *    exists on v1; this module has no such step kind.
 *  - withdraw (capital + released profit): only with no open position.
 *  - Earn exit: request (76) then, once the cooldown has elapsed, execute (77). A pending request
 *    whose cooldown is running is "waiting", never "ready".
 *  - creator fees: independent of everything else.
 *  - deposit into v2.1: only when the successor exists, v2.1 is live, and every v1 step for the
 *    market is done. Otherwise the flow stops at "in your wallet".
 */
import { slotsToDuration } from "../lock-episode";
import type { SuccessorEntry } from "./successors";

export type StepKind =
  | "close"
  | "withdraw"
  | "earn-request"
  | "earn-execute"
  | "claim-creator-fee"
  | "deposit-market"
  | "deposit-earn";

export type StepStatus = "done" | "ready" | "waiting" | "blocked" | "unavailable" | "skipped";

export interface MoveStep {
  id: string;
  kind: StepKind;
  slab: string;
  status: StepStatus;
  /** Calm, honest one-liner: what this is, or why it is not available yet. */
  line: string;
  /** Slots until a waiting step becomes ready. */
  waitSlots?: bigint;
}

export interface V1MarketSnapshot {
  slab: string;
  symbol: string;
  mint: string | null;
  collateralDecimals: number;
  resolved: boolean;
  /** null = the wallet has no portfolio on this market. */
  portfolio: null | {
    capital: bigint;
    /** Released, backed profit that withdraw converts first (0 when none / not yet quoted). */
    releasedPnl: bigint;
    openLegs: number;
    closeOnly: boolean;
  };
  /** null = the wallet has no Earn stake here. */
  earn: null | {
    /** LP shares held in the wallet (not yet requested). */
    shares: bigint;
    /** A pending withdrawal request, if any. */
    pending: null | { shares: bigint; unlockSlot: bigint };
    /** The vault refuses new requests right now (paused / impaired). */
    requestsPaused: boolean;
  };
  creatorFeeAtoms: bigint;
  /** What the wallet already holds on the v2.1 successor (resume: deposit is done if > 0). */
  v21: { marketCapital: bigint; earnShares: bigint };
}

export interface MoveInput {
  nowSlot: bigint;
  markets: readonly V1MarketSnapshot[];
  successors: readonly SuccessorEntry[];
  /** v2.1 programs are configured (NEXT_PUBLIC_V21_*). */
  v21Live: boolean;
  /** Resolve a successor for a market (injected so the map stays data). */
  successorOf: (m: V1MarketSnapshot) => SuccessorEntry | null;
}

export interface MarketPlan {
  slab: string;
  symbol: string;
  steps: MoveStep[];
  /** Successor state, for honest copy. */
  successor: "ready" | "none" | "v21-not-live";
  /** Every v1 step is done or skipped. */
  v1Clear: boolean;
}

export interface MovePlan {
  markets: MarketPlan[];
  /** All markets finished (nothing ready, waiting or blocked, deposits done or unavailable). */
  complete: boolean;
}

const idOf = (slab: string, kind: StepKind): string => `${slab}:${kind}`;

export function buildMarketPlan(m: V1MarketSnapshot, i: MoveInput): MarketPlan {
  const steps: MoveStep[] = [];
  const add = (kind: StepKind, status: StepStatus, line: string, waitSlots?: bigint): MoveStep => {
    const s: MoveStep = { id: idOf(m.slab, kind), kind, slab: m.slab, status, line, ...(waitSlots !== undefined ? { waitSlots } : {}) };
    steps.push(s);
    return s;
  };
  const pf = m.portfolio;
  const earn = m.earn;
  const open = pf ? pf.openLegs > 0 : false;

  // 1. close. Always allowed.
  if (pf && open) {
    add("close", "ready", pf.closeOnly
      ? "Close your position. Closing is always open, including while this market winds down."
      : "Close your position. Closing is always open.");
  } else if (pf) {
    add("close", "done", "No open position.");
  }

  // 2. withdraw (capital and released profit).
  if (pf) {
    const hasFunds = pf.capital > 0n || pf.releasedPnl > 0n;
    if (open) add("withdraw", "blocked", "Close your position first. Funds backing an open position cannot be withdrawn.");
    else if (m.resolved && hasFunds) add("withdraw", "ready", "This market is settled. Withdraw what is yours.");
    else if (hasFunds) add("withdraw", "ready", pf.releasedPnl > 0n ? "Withdraw your balance, including settled profit, to your wallet." : "Withdraw your balance to your wallet.");
    else add("withdraw", "done", "Nothing left to withdraw.");
  }

  // 3. Earn exit.
  if (earn) {
    if (earn.pending) {
      add("earn-request", "done", "Withdrawal requested.");
      const remaining = earn.pending.unlockSlot > i.nowSlot ? earn.pending.unlockSlot - i.nowSlot : 0n;
      if (remaining > 0n) add("earn-execute", "waiting", `Your withdrawal unlocks in about ${slotsToDuration(remaining)}. We will pick up here when you come back.`, remaining);
      else add("earn-execute", "ready", "Your withdrawal is unlocked. Collect it to your wallet.");
    } else if (earn.shares > 0n) {
      if (earn.requestsPaused) {
        add("earn-request", "blocked", "This vault is not taking withdrawal requests right now. Nothing is lost; try again later.");
      } else {
        add("earn-request", "ready", "Request your Earn withdrawal. It unlocks after a short waiting period.");
      }
      add("earn-execute", "waiting", "Available after the waiting period that starts when you request.");
    } else {
      add("earn-request", "done", "No Earn balance.");
    }
  }

  // 4. creator fees.
  if (m.creatorFeeAtoms > 0n) add("claim-creator-fee", "ready", "Claim the trading fees this market earned for you.");

  const v1Steps = steps.filter((s) => s.kind !== "deposit-market" && s.kind !== "deposit-earn");
  const v1Clear = v1Steps.every((s) => s.status === "done" || s.status === "skipped");

  // 5. deposit into the v2.1 successor.
  const succ = i.v21Live ? i.successorOf(m) : null;
  const succReady = !!succ && !!succ.v21Slab;
  const successor: MarketPlan["successor"] = !i.v21Live ? "v21-not-live" : succReady ? "ready" : "none";
  // "Held on v1" is an on-chain fact that survives a full withdrawal (the portfolio / LP token account
  // still exists), so a deposit step stays offered after the funds reach the wallet: resume never loses it.
  const hadMarket = !!pf || m.v21.marketCapital > 0n;
  const hadEarn = !!earn || m.v21.earnShares > 0n;
  const noSuccLine = !i.v21Live
    ? "v2.1 is not open yet. Your funds stay in your wallet until it is."
    : `There is no v2.1 market for ${m.symbol} yet. Your funds stay in your wallet.`;
  if (hadMarket) {
    if (!succReady) add("deposit-market", "unavailable", noSuccLine);
    else if (m.v21.marketCapital > 0n) add("deposit-market", "done", "Already deposited on v2.1.");
    else if (!v1Clear) add("deposit-market", "waiting", "Available once your v1 funds are in your wallet.");
    else add("deposit-market", "ready", `Deposit into the v2.1 ${m.symbol} market.`);
  }
  if (hadEarn) {
    if (!succReady || !succ?.v21Earn) add("deposit-earn", "unavailable", noSuccLine);
    else if (m.v21.earnShares > 0n) add("deposit-earn", "done", "Already in the v2.1 Earn vault.");
    else if (!v1Clear) add("deposit-earn", "waiting", "Available once your Earn withdrawal reaches your wallet.");
    else add("deposit-earn", "ready", `Deposit into the v2.1 ${m.symbol} Earn vault.`);
  }

  return { slab: m.slab, symbol: m.symbol, steps, successor, v1Clear };
}

export function buildMovePlan(i: MoveInput): MovePlan {
  const markets = i.markets
    .map((m) => buildMarketPlan(m, i))
    .filter((p) => p.steps.length > 0);
  const complete = markets.every((p) =>
    p.steps.every((s) => s.status === "done" || s.status === "skipped" || s.status === "unavailable"),
  );
  return { markets, complete };
}

/** An executable unit: one transaction (or one sim-gated bundle) the runner sends. */
export interface MoveAction {
  slab: string;
  /** Steps this single transaction completes. */
  kinds: StepKind[];
  /** Simulate before sending; refuse to send on a failed simulation. */
  simulate: boolean;
}

/**
 * The next executable actions: every ready step, one transaction each. Batching is only ever
 * within a step the existing builders already bundle (withdraw = convert profit + withdraw;
 * Earn execute = cranks + 77); we never merge a close with a withdraw, because the withdraw amount
 * depends on the post-close state and must be re-read.
 */
export function nextActions(plan: MovePlan): MoveAction[] {
  const out: MoveAction[] = [];
  for (const m of plan.markets) {
    for (const s of m.steps) {
      if (s.status !== "ready") continue;
      out.push({ slab: m.slab, kinds: [s.kind], simulate: s.kind !== "claim-creator-fee" });
    }
  }
  return out;
}

export type PlanSummary = "nothing-to-move" | "ready" | "waiting" | "blocked" | "complete";

export function summarizePlan(plan: MovePlan): PlanSummary {
  if (plan.markets.length === 0) return "nothing-to-move";
  const all = plan.markets.flatMap((m) => m.steps);
  if (all.some((s) => s.status === "ready")) return "ready";
  if (all.some((s) => s.status === "waiting")) return "waiting";
  if (all.some((s) => s.status === "blocked")) return "blocked";
  return "complete";
}
