/**
 * The auto-resume runner: scan -> plan -> run the next ready action -> scan again, until nothing is
 * ready. All chain access and signing is injected, so the loop is deterministic and testable.
 * Steps with no executor (the ones that live in a market's own page flow) stop the loop as a
 * "handoff" with the step to open; the page flow does the work and the next scan sees it done.
 */
import type { TransactionInstruction } from "@solana/web3.js";
import type { ProgramIdSet } from "@/lib/program-ids";
import { assertV1Program, assertV21Program } from "./ids";
import { buildMovePlan, nextActions, type MoveAction, type MoveInput, type MovePlan, type StepKind } from "./plan";

/** Wrapper tags that exist only on v2.1 (tag 103 bound-trade prefix, tag 104 ADL wind-down). */
export const V21_ONLY_TAGS: readonly number[] = [103, 104];

const V21_KINDS: readonly StepKind[] = ["deposit-market", "deposit-earn"];

/** Throws if a v1-targeted transaction carries a v2.1-only wrapper instruction. */
export function assertNoV21OnlyTags(programId: string, ixs: readonly Pick<TransactionInstruction, "programId" | "data">[]): void {
  for (const ix of ixs) {
    if (ix.programId.toBase58() === programId && ix.data.length > 0 && V21_ONLY_TAGS.includes(ix.data[0])) {
      throw new Error(`Move: tag ${ix.data[0]} is v2.1-only and is never sent to the v1 wrapper`);
    }
  }
}

/** Refuse an action aimed at the wrong world. */
export function guardAction(action: MoveAction, v1Wrapper: string, v21: ProgramIdSet | null): void {
  if (action.kinds.every((k) => V21_KINDS.includes(k))) assertV21Program(v21?.wrapper ?? "", v21);
  else if (action.kinds.some((k) => V21_KINDS.includes(k))) throw new Error("Move: v1 and v2.1 steps are never in one transaction");
  else assertV1Program(v1Wrapper);
}

/** Resolves to the signature, or null when the step turned out to be already done (nothing sent). */
export type Executor = (action: MoveAction) => Promise<string | null>;
export type Executors = Partial<Record<StepKind, Executor>>;

export type RunStop =
  | { reason: "complete" | "waiting" | "blocked" | "nothing-to-move" }
  | { reason: "handoff"; action: MoveAction }
  | { reason: "no-progress"; action: MoveAction }
  | { reason: "limit" }
  | { reason: "error"; action: MoveAction; error: unknown };

export interface RunDeps {
  scan: () => Promise<MoveInput>;
  executors: Executors;
  v1Wrapper: string;
  v21: ProgramIdSet | null;
  /** Hard cap on transactions per run. */
  maxActions?: number;
  onSent?: (action: MoveAction, signature: string) => void;
  /** Run only actions this accepts (a per-step button); others are left for the next run. */
  only?: (action: MoveAction) => boolean;
}

export async function runMove(deps: RunDeps): Promise<{ stop: RunStop; plan: MovePlan; sent: string[] }> {
  const max = deps.maxActions ?? 24;
  const sent: string[] = [];
  let input = await deps.scan();
  let plan = buildMovePlan(input);
  let lastId: string | null = null;
  for (let n = 0; n < max; n++) {
    const action = nextActions(plan).filter((a) => deps.only?.(a) ?? true)[0];
    if (!action) {
      const all = plan.markets.flatMap((m) => m.steps);
      const reason = all.length === 0 ? "nothing-to-move" : all.some((s) => s.status === "waiting") ? "waiting" : all.some((s) => s.status === "blocked") ? "blocked" : "complete";
      return { stop: { reason }, plan, sent };
    }
    const id = `${action.slab}:${action.kinds.join("+")}`;
    if (id === lastId) return { stop: { reason: "no-progress", action }, plan, sent };
    guardAction(action, deps.v1Wrapper, deps.v21);
    const exec = deps.executors[action.kinds[0]];
    if (!exec) return { stop: { reason: "handoff", action }, plan, sent };
    try {
      const sig = await exec(action);
      if (sig !== null) {
        sent.push(sig);
        deps.onSent?.(action, sig);
      }
    } catch (error) {
      return { stop: { reason: "error", action, error }, plan, sent };
    }
    lastId = id;
    input = await deps.scan();
    plan = buildMovePlan(input);
    // progress: the same step is no longer ready (next loop re-checks lastId against a still-ready step)
    if (!nextActions(plan).some((a) => `${a.slab}:${a.kinds.join("+")}` === id)) lastId = null;
  }
  return { stop: { reason: "limit" }, plan, sent };
}
