/**
 * UX WP-8 (audit §3.9, RX-1): "Finish now" in ONE approval.
 *
 * Every step that can finish the market is planned up front from the decoded portfolios, and the
 * steps the program may need to REPEAT (101 SettleVaultLpResolved, 30 CloseResolved are chunked)
 * are pre-signed in several copies with distinct compute-unit prices (so each copy has its own
 * signature). The whole list is signed with one signAllCompat. The driver then broadcasts in order,
 * re-reading the market before each transaction and skipping any copy whose step is no longer
 * needed — unneeded copies are NEVER broadcast (AC4). The user's own Earn request (76) can ride at
 * the end, so the withdrawal's pending card (WP-4) takes it from there.
 * Pure planning + an injected driver (no RPC here).
 */
import { errorText } from "@/lib/error-text";
import type { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { buildBatchTx } from "@/lib/tx";
import { formatTokenAmount } from "@/lib/format";
import type { ExitPortfolio, ExitStep, ResolvedExitPlan } from "./resolved-exit";
import { exitStepsCu, looksEmpty } from "./resolved-exit";
import { exitStepIxs, type ExitIxContext } from "./resolved-exit-ixs";
import { finishFeeSol } from "./resolved-eta";
import { earnRequestQuoteAtoms } from "./earn-ixs";

/** How many copies of a repeatable step are pre-signed ("settle-vault-lp" = the 101 close step;
 *  "settle-vault-lp-topup" = 101(1), repeated until the vault LP's receipt is final; the "retry"
 *  copies run again after the traders' closes, for a vault LP that won). */
export const FINISH_COPIES = {
  "settle-vault-lp": 3,
  "settle-vault-lp-topup": 2,
  "settle-vault-lp-retry": 2,
  "close-resolved": 3,
} as const;

export interface FinishItem {
  /** The step this tx runs (a copy repeats the same step). */
  step: ExitStep | { kind: "earn-request" };
  /** 0-based copy index of a repeatable step (0 for single steps). */
  copy: number;
}

const stepKey = (s: FinishItem["step"]): string =>
  s.kind === "earn-request" ? "earn-request" : s.kind === "harvest" ? "harvest" : `${s.kind}:${"portfolio" in s ? s.portfolio : ""}:${s.kind === "settle-vault-lp" ? s.topup : ""}`;

const receiptOpen = (v: ExitPortfolio["view"]): boolean => v.receiptPresent && !v.receiptFinalized;

/**
 * The finish list, in the program's order. The two sides wait on each other (a winning trader's
 * close is partial / progress-only until the vault LP settles; a winning vault LP's 101 is
 * progress-only until every trader leg has detached), and an open receipt is diluted by ANY
 * claimant still unreceipted, so:
 *   A. the vault LP settles (101 close step, then 101(1) while its receipt is open);
 *   B. tag 46 for every open trader receipt, the VIEWER's own first;
 *   C. each trader not yet closed closes (30): losers first, then winners, the viewer's first;
 *   D. 101 again (a vault LP that won could only finish once the traders detached);
 *   E. per trader, viewer first: 30 again (a winner that was still progress-only), then 46 again
 *      (receipts opened or still diluted during A-D);
 *   F. empty portfolios close (8), then the bound vault harvests (78);
 *   G. (optionally) the viewer's own Earn request (76), last.
 * The driver re-plans before each item and skips what is not needed; nothing unneeded is sent.
 * Viewer-first matters because the list is capped at FINISH_MAX_TXS: the viewer's own payout is
 * never the part left to the keeper. Escrowed (NFT) and mid-liquidation portfolios are skipped:
 * nobody but their owner / the engine can move them.
 */
export function buildFinishList(input: {
  portfolios: readonly ExitPortfolio[];
  boundVault: boolean;
  withEarnRequest: boolean;
  /** Owners' window: only these portfolios can be touched now (the plan's own steps). */
  only?: ReadonlySet<string>;
  /** Portfolio keys the connected wallet owns (lib/limits/resolved-topup viewerOwnedKeys). */
  viewerOwned?: ReadonlySet<string>;
}): FinishItem[] {
  const out: FinishItem[] = [];
  const pick = (p: ExitPortfolio) => !input.only || input.only.has(p.key);
  const mine = (p: ExitPortfolio) => input.viewerOwned?.has(p.key) === true;
  const viewerFirst = (a: ExitPortfolio, b: ExitPortfolio) => Number(mine(b)) - Number(mine(a));
  const vault = input.portfolios.filter((p) => p.isVaultLp && pick(p) && !looksEmpty(p.view));
  const traders = input.portfolios
    .filter((p) => !p.isVaultLp && pick(p) && !p.escrowed && !p.view.rebalanceLock && !p.view.liquidationLock)
    .sort(viewerFirst);
  const live = traders.filter((t) => !looksEmpty(t.view));
  const settle = (v: ExitPortfolio, from: number, n0: number, n1: number) => {
    for (let c = 0; c < n0; c++) out.push({ step: { kind: "settle-vault-lp", topup: 0, portfolio: v.key }, copy: from + c });
    for (let c = 0; c < n1; c++) out.push({ step: { kind: "settle-vault-lp", topup: 1, portfolio: v.key }, copy: from + c });
  };
  // A
  for (const v of vault) settle(v, 0, FINISH_COPIES["settle-vault-lp"], FINISH_COPIES["settle-vault-lp-topup"]);
  // B
  for (const t of live) if (receiptOpen(t.view)) out.push({ step: { kind: "claim-topup", portfolio: t.key }, copy: 0 });
  // C: losers first (a winner's close is progress-only until the losing side has paid in), then
  // winners; the viewer first within each.
  const closing = live.filter((t) => !receiptOpen(t.view)).sort((a, b) => Number(a.view.pnl > 0n) - Number(b.view.pnl > 0n) || viewerFirst(a, b));
  for (const t of closing) {
    for (let c = 0; c < FINISH_COPIES["close-resolved"]; c++) out.push({ step: { kind: "close-resolved", portfolio: t.key }, copy: c });
  }
  // D (only when a trader still had to close: otherwise A already covered the vault LP)
  if (closing.length > 0) {
    const n = FINISH_COPIES["settle-vault-lp-retry"];
    for (const v of vault) settle(v, 10, n, n);
  }
  // E: a winner whose close was still progress-only closes again, then every open receipt tops up.
  for (const t of live) {
    if (!receiptOpen(t.view)) out.push({ step: { kind: "close-resolved", portfolio: t.key }, copy: 10 });
    out.push({ step: { kind: "claim-topup", portfolio: t.key }, copy: 1 });
  }
  // F
  const all = [...input.portfolios.filter((p) => p.isVaultLp && pick(p)), ...traders];
  for (const p of all) out.push({ step: { kind: "close-empty", portfolio: p.key, isVaultLp: p.isVaultLp }, copy: 0 });
  if (input.boundVault) out.push({ step: { kind: "harvest" }, copy: 0 });
  // G
  if (input.withEarnRequest) out.push({ step: { kind: "earn-request" }, copy: 0 });
  return out;
}

/**
 * Drop what the pre-sign simulation refused, BEFORE the wallet opens. A refused 30 / 101 / 8 drops
 * its portfolio's whole chain (nothing later in it can land); a refused 46 drops only that one
 * item: an open receipt's top-up can have nothing more to pay NOW and still pay after the 101 /
 * the other closes later in the list (a partial receipt is diluted by every unreceipted claim).
 */
export function pruneRefusedItems(items: readonly FinishItem[], refused: readonly FinishItem[]): FinishItem[] {
  const chain = (it: FinishItem) => ("portfolio" in it.step ? it.step.portfolio : it.step.kind);
  const one = (it: FinishItem) => `${stepKey(it.step)}#${it.copy}`;
  const chains = new Set<string>();
  const singles = new Set<string>();
  for (const r of refused) {
    if (r.step.kind === "claim-topup") singles.add(one(r));
    else chains.add(chain(r));
  }
  return items.filter((it) => !chains.has(chain(it)) && !singles.has(one(it)));
}

/** The portfolios a plan touches now (for `only` during the owners' window). */
export function planPortfolios(plan: ResolvedExitPlan): Set<string> {
  const out = new Set<string>();
  if (plan.phase === "sweep" || plan.phase === "owner-window") for (const s of plan.steps) if ("portfolio" in s) out.add(s.portfolio);
  return out;
}

/** Compute budget of one finish tx (one step per tx, so skipping a copy is exact). */
export const EARN_REQUEST_CU = 60_000;
export const finishItemCu = (item: FinishItem): number => (item.step.kind === "earn-request" ? EARN_REQUEST_CU : exitStepsCu([item.step]));

/** Instructions for one finish item; the Earn request is built by the caller (lib/limits/earn-ixs buildRequestRedeemIx). */
export function finishItemIxs(item: FinishItem, ctx: ExitIxContext, earnRequest: TransactionInstruction | null): TransactionInstruction[] {
  if (item.step.kind === "earn-request") {
    if (!earnRequest) throw new Error("earn-request item without the request instruction");
    return [earnRequest];
  }
  return exitStepIxs(item.step, ctx);
}

/**
 * Most transactions one "Finish now" asks the wallet to sign. One blockhash lives ~60-90 s and
 * each broadcast is confirmed before the next, so a longer list would expire mid-run anyway; the
 * keeper finishes whatever is left.
 */
export const FINISH_MAX_TXS = 24;

/** Is this item's step still needed, per a fresh plan? */
export function stepNeeded(item: FinishItem, plan: ResolvedExitPlan): boolean {
  if (item.step.kind === "earn-request") return plan.phase === "ready";
  if (plan.phase === "ready" || plan.phase === "not-resolved") return false;
  const k = stepKey(item.step);
  return plan.steps.some((s) => stepKey(s) === k);
}

export interface FinishDriverDeps<Tx> {
  plan: () => Promise<ResolvedExitPlan>;
  broadcast: (tx: Tx) => Promise<string>;
}

export interface FinishRun {
  broadcast: number;
  skipped: number;
  failed: number;
  signatures: string[];
  final: ResolvedExitPlan;
  /** The pre-signed list stopped being usable (e.g. its blockhash expired). */
  stale: boolean;
  /** The user's own Earn request (76) was broadcast and landed. */
  requested: boolean;
}

/**
 * Broadcast the pre-signed list in order, re-planning before each item and skipping any item not
 * needed. A failed copy does not stop later steps; an expired blockhash stops the run (the regular
 * sweep picks up the rest).
 */
export async function runFinish<Tx>(items: readonly { item: FinishItem; tx: Tx }[], d: FinishDriverDeps<Tx>): Promise<FinishRun> {
  const signatures: string[] = [];
  let skipped = 0;
  let failed = 0;
  let stale = false;
  let requested = false;
  let plan = await d.plan();
  for (const { item, tx } of items) {
    if (!stepNeeded(item, plan)) {
      skipped++;
      continue;
    }
    try {
      signatures.push(await d.broadcast(tx));
      if (item.step.kind === "earn-request") requested = true;
    } catch (e) {
      failed++;
      if (/blockhash not found|block height exceeded|expired/i.test(errorText(e))) {
        stale = true;
        break;
      }
    }
    plan = await d.plan();
  }
  if (stale) plan = await d.plan();
  return { broadcast: signatures.length, skipped, failed, signatures, final: plan, stale, requested };
}

/** What "Finish now" would do: distinct steps (copies not counted) and the fee estimate. */
export function finishEstimate(items: readonly FinishItem[]): { steps: number; sol: string } {
  const seen = new Set<string>();
  const firsts = items.filter((i) => {
    if (i.step.kind === "earn-request") return false;
    const k = stepKey(i.step);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const payoutAccounts = firsts.filter((i) => i.step.kind === "close-resolved" || (i.step.kind === "settle-vault-lp" && i.step.topup === 0)).length;
  const txs = items.filter((i) => i.step.kind !== "earn-request").length;
  return { steps: firsts.length, sol: finishFeeSol({ txs, payoutAccounts }) };
}

/**
 * One unsigned tx per item, all on one blockhash. Each tx gets a DISTINCT compute-unit price
 * (base + index + 1): two copies of one step would otherwise be byte-identical, share a signature,
 * and the second would be dropped as a duplicate.
 */
export function buildFinishTxs(
  items: readonly FinishItem[],
  ctx: ExitIxContext,
  earnRequest: TransactionInstruction | null,
  o: { blockhash: string; priorityFeeMicroLamports: number; feePayer: PublicKey },
): Transaction[] {
  return items.map((it, i) =>
    buildBatchTx({
      instructions: finishItemIxs(it, ctx, earnRequest),
      computeUnits: finishItemCu(it),
      priorityFeeMicroLamports: o.priorityFeeMicroLamports + i + 1,
      blockhash: o.blockhash,
      feePayer: o.feePayer,
    }),
  );
}

/**
 * What the settled-market panel shows for the viewer's own Earn position: the amount in the ETA
 * line, and the shares "Finish now" may request (none while a request is already pending: WP-4's
 * pending card owns that withdrawal).
 */
export function earnExitProps(
  s: {
    userLpBalance: bigint;
    userRedeemableValue: bigint;
    pendingRedemptionShares: bigint;
    splitPot?: { navAtoms: bigint; totalShares: bigint } | null;
    backingNavAtoms?: bigint;
    lpSupply?: bigint;
  },
  decimals: number,
  symbol: string,
): { earnAmount: string | null; requestableShares: bigint; requestQuoteAtoms: bigint | null } {
  if (s.userLpBalance <= 0n) return { earnAmount: null, requestableShares: 0n, requestQuoteAtoms: null };
  const requestableShares = s.pendingRedemptionShares > 0n ? 0n : s.userLpBalance;
  return {
    earnAmount: `${formatTokenAmount(s.userRedeemableValue, decimals, 2)} ${symbol}`,
    requestableShares,
    // AUD-S1-18: the floored 76 in the finish batch takes its floor from this quote.
    requestQuoteAtoms: earnRequestQuoteAtoms(requestableShares, s),
  };
}
