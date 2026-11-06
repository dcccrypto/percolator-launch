/**
 * Should a trade/close be preceded by a PermissionlessCrank on the TAKER's own portfolio?
 *
 * useTrade used to PREPEND that crank to the trade, in the same transaction, whenever the
 * taker had an active leg. Measured on devnet (2026-10-01, wrapper bd4fe5f8, a fresh
 * non-creator wallet, the app's own builders, 12 rounds per market): the trade ALONE
 * simulated clean 72/72, while crank + trade in ONE tx failed the trade with Custom(21)
 * EngineLockActive on most rounds (PERC long 9/12, short 10/12; SI long 10/12). 21 is a
 * "waitable" refusal, so the ticket sat on "Waiting for the latest price" for every trader
 * holding a position: adds, flips and closes (useClosePosition goes through trade()).
 *
 * WHY (engine 35ddd692 / wrapper bd4fe5f8): a crank carrying an asset-0 hint copies the
 * keeper's latest mark into `asset.raw_oracle_target_price` (wrapper v16_program.rs:23460 ->
 * engine v16.rs:14643) but may only walk `effective_price` toward it by
 * max_price_move_bps_per_slot x dt (wrapper :9279/:9298; dt is often 0-2 slots right after
 * the keeper's crank). A risk-increasing trade then hits the engine's intended
 * target/effective-lag guard: `asset_has_target_effective_lag` (engine :16556,
 * raw != effective) -> `trade_preflight_risk_gate` (engine :22593-22603) -> LockActive -> 21.
 * Without our crank raw == effective (PushAuthMark never writes raw), so the trade passes.
 * The lag clears only when a LATER crank's walk reaches the target. Upstream has the same gate.
 *
 * So the crank is never put in the trade's transaction. The trade path refreshes and
 * recertifies both portfolios itself (engine :18156-18173); a taker crank only helps when
 * the trade alone is refused with EngineStale (19) or EngineBStale (20) (wrapper pre-check
 * :31132-31170, portfolios with 8+ active legs, or a pending B-chunk) AND the crank alone
 * simulates clean. Only then is it sent, as a SEPARATE prior transaction; the trade is then
 * simulated afresh by sendTx as usual. A lagging engine clock is not this path's
 * job: lib/self-heal.ts catches it up by cranking the market's LP, and only keeps those
 * cranks when the healed list simulates without a repairable refusal.
 */
import type { TransactionInstruction } from "@solana/web3.js";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { parseCustomInstructionError } from "@/lib/self-heal";

/** The refusals a prior taker crank can actually clear (see the module comment). */
const TAKER_CRANK_CURABLE = new Set<number>([WRAPPER_ERR.EngineStale, WRAPPER_ERR.EngineBStale]);

export interface TakerCrankSim {
  err: unknown;
  /** The simulation RPC itself failed: no verdict. */
  rpcFailed: boolean;
}

export type TakerCrankPlan = "none" | "separate-tx" | "bundle";

/**
 * Council GO1106 (first-timer): one Close click cost 4 wallet prompts. The close alone simulated clean, then LANDED
 * failed with Stale(19) (the certificate went behind between simulation and landing), and the C1 resend then needed
 * a separate crank tx before the close: failed close + crank + close + the sweep. A close is RISK-REDUCING, so the
 * target/effective-lag gate that makes [crank, trade] fail 21 for opens (module comment) is not the gate a close
 * meets. For a close we therefore try the crank IN the close's own transaction first, and keep it only when that
 * exact list simulates clean: one approval, and the in-tx crank re-certifies the portfolio at landing time, so the
 * Stale race above cannot happen. If the bundle is refused (any error) the plan is exactly the old one.
 */
export async function planTakerCrank(
  simulate: (instructions: TransactionInstruction[]) => Promise<TakerCrankSim>,
  tradeIxs: TransactionInstruction[],
  crankIx: TransactionInstruction,
  /** Instructions `simulate` puts in front of the list (simulateForGate: 2 compute-budget ixs). */
  prefixLen = 0,
  /** The order only reduces the taker's open position (a close / partial close): try the same-tx crank first. */
  reducing = false,
): Promise<TakerCrankPlan> {
  if (reducing) {
    const bundled = await simulate([crankIx, ...tradeIxs]);
    if (!bundled.rpcFailed && !bundled.err) return "bundle";
  }
  const alone = await simulate(tradeIxs);
  if (alone.rpcFailed || !alone.err) return "none";
  const refusal = parseCustomInstructionError(alone.err);
  if (!refusal || !TAKER_CRANK_CURABLE.has(refusal.code)) return "none";
  const failing = tradeIxs[refusal.index - prefixLen];
  if (!failing || !failing.programId.equals(crankIx.programId)) return "none";
  const crank = await simulate([crankIx]);
  if (crank.rpcFailed || crank.err) return "none";
  return "separate-tx";
}
