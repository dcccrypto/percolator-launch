/**
 * Earn senior exit after a market RESOLVES (P3 424fe7e4; F-4 + P3-H1 + F-8).
 *
 * ExecuteRedemption (77) in Resolved mode needs a TERMINAL-FLAT market:
 * `materialized_portfolio_count == 0 && c_tot == 0` (`handle_execute_redemption`, #377). One
 * walked-away trader used to lock every Earn depositor (F-4). The program now lets ANYONE
 * finish the market, and this module plans that sweep from decoded state:
 *
 *   vault LP (bound):  101 VaultLpSettleResolved(0) [+ 101(1) while its payout receipt is
 *                      unfinalized]  ->  8 ClosePortfolio with owner = registry PDA
 *   each trader:       30 CloseResolved (permissionless after force_close_delay_slots; pays the
 *                      OWNER's ATA)  ->  46 top-up while its receipt is unfinalized  ->
 *                      8 ClosePortfolio (F-4: any signer, rent to the owner)
 *
 * The vault LP goes first: a winning trader's resolved close is progress-only until its losing
 * counterparty (the vault LP) has settled (P3 final pass). The emptiness test here is the
 * subset of the engine's `is_empty_for_dematerialization` the app can decode; close-progress
 * and source-domain slots are not decoded, so every step is simulated before it is sent and a
 * refused step is reported, never retried blindly.
 *
 * Pure: no RPC. `useResolvedExit` feeds it and executes the plan.
 */
import { MARKET_MODE_RESOLVED } from "./constants";
import type { ResolvedMarketView, ResolvedPortfolioView } from "./decode";

export interface ExitPortfolio {
  /** base58 key (the planner never builds keys). */
  key: string;
  view: ResolvedPortfolioView;
  /** The owner is an off-curve PDA that is not this market's LP-vault registry => most likely
   *  NFT-escrowed: an unsigned 30/46 is refused (GH#496), its holder must act. */
  escrowed: boolean;
  isVaultLp: boolean;
}

export type ExitStep =
  /** 07a1d0eb: tag 78 on a BOUND vault once the market is terminal-flat (fees -> backing + C). */
  | { kind: "harvest" }
  | { kind: "settle-vault-lp"; topup: 0 | 1; portfolio: string }
  | { kind: "close-resolved"; portfolio: string }
  | { kind: "claim-topup"; portfolio: string }
  | { kind: "close-empty"; portfolio: string; isVaultLp: boolean };

export type ExitBlocker =
  | { kind: "escrowed"; portfolio: string }
  | { kind: "locked"; portfolio: string };

export type ResolvedExitPlan =
  | { phase: "not-resolved" }
  /** Live-mode resolve not done; or the owner-only window: trader/vault closes need their owner until `untilSlot`. */
  /** `ownersPending`: portfolios only their owner may close before `untilSlot` (absent = none), so the market cannot finish sooner. */
  | { phase: "owner-window"; untilSlot: bigint; steps: ExitStep[]; blockers: ExitBlocker[]; ownersPending?: number }
  | { phase: "sweep"; steps: ExitStep[]; blockers: ExitBlocker[] }
  /** Terminal-flat: the Earn redemption (76 -> 77) can run now. */
  | { phase: "ready"; blockers: ExitBlocker[] };

/** Decodable subset of the engine's `is_empty_for_dematerialization`. */
export function looksEmpty(p: ResolvedPortfolioView): boolean {
  return (
    p.activeBitmap === 0n &&
    p.capital === 0n &&
    p.pnl === 0n &&
    p.reservedPnl === 0n &&
    p.feeCredits === 0n &&
    p.cancelDepositEscrow === 0n &&
    !p.stale &&
    !p.bStale &&
    !p.rebalanceLock &&
    !p.liquidationLock &&
    (!p.receiptPresent || p.receiptFinalized)
  );
}

const receiptOpen = (p: ResolvedPortfolioView): boolean => p.receiptPresent && !p.receiptFinalized;

/** End of the owner-only window (tag 30 / the 101 close step): `resolved_slot + delay`. */
export function ownerWindowEnd(m: ResolvedMarketView): bigint {
  return m.forceCloseDelaySlots === 0n ? 0n : m.resolvedSlot + m.forceCloseDelaySlots;
}

/**
 * Plan the next steps. `nowSlot` is the chain slot (the program admits the authenticated Clock
 * into the resolved clock). `harvestableAtoms` is `lp_vault_harvestable_fee_atoms`: a bound
 * vault's 77 refuses 84 while it is non-zero; since 07a1d0eb tag 78 runs on a Resolved bound
 * vault once TERMINAL-FLAT, so the sweep ends with a "harvest" step (then the redemption pays).
 */
export function planResolvedExit(input: {
  market: ResolvedMarketView;
  nowSlot: bigint;
  portfolios: readonly ExitPortfolio[];
  boundVault: boolean;
  harvestableAtoms: bigint | null;
  /** F-14 claim-free residual (decodeTerminalBacking); 78 absorbs it at terminal-flat. */
  terminalResidualAtoms?: bigint | null;
  /**
   * The fee payer is the vault's junior owner. Tag 101 admits the junior owner inside the owner window
   * (percolator-prog aca02ba6 `v16_program.rs` `... && caller.key != &junior_owner { return Err(Unauthorized) }`),
   * so its close step is planned now instead of after `force_close_delay_slots` (216,000 slots, about 24 h).
   */
  juniorOwnerPays?: boolean;
}): ResolvedExitPlan {
  const { market, nowSlot, portfolios, boundVault, harvestableAtoms } = input;
  const residual = input.terminalResidualAtoms ?? 0n;
  if (market.mode !== MARKET_MODE_RESOLVED) return { phase: "not-resolved" };
  const blockers: ExitBlocker[] = [];

  const windowEnd = ownerWindowEnd(market);
  const inWindow = nowSlot < windowEnd;
  const steps: ExitStep[] = [];
  let ownersPending = 0;
  const juniorEarly: ExitStep[] = [];
  const vault = portfolios.filter((p) => p.isVaultLp);
  const traders = portfolios.filter((p) => !p.isVaultLp);

  for (const v of vault) {
    if (looksEmpty(v.view)) steps.push({ kind: "close-empty", portfolio: v.key, isVaultLp: true });
    else if (receiptOpen(v.view)) steps.push({ kind: "settle-vault-lp", topup: 1, portfolio: v.key });
    else if (!inWindow) steps.push({ kind: "settle-vault-lp", topup: 0, portfolio: v.key });
    else if (input.juniorOwnerPays === true) juniorEarly.push({ kind: "settle-vault-lp", topup: 0, portfolio: v.key });
  }
  // Both directions depend on each other (P3 final pass + 5e4c15ff): a WINNING trader's close is
  // progress-only (or pays a PARTIAL receipt) until the vault LP has settled, and a WINNING vault
  // LP's 101 is progress-only until every trader leg has detached. So trader closes are planned
  // alongside the 101 (the vault LP-wins case would otherwise never finish: measured on real BPF,
  // limits_app_p3_partial_receipt_topup_after_101). An open (partial) receipt is diluted by ANY
  // claimant still unreceipted — the vault LP or another trader — so its 46 top-up is planned
  // whenever the receipt is open; the finish list repeats it after the 101 retry, and every step
  // is simulated first (a 46 with nothing more to pay yet is skipped, not broadcast).
  for (const t of traders) {
    if (looksEmpty(t.view)) {
      steps.push({ kind: "close-empty", portfolio: t.key, isVaultLp: false });
      continue;
    }
    if (t.escrowed) {
      blockers.push({ kind: "escrowed", portfolio: t.key });
      continue;
    }
    if (t.view.rebalanceLock || t.view.liquidationLock) {
      blockers.push({ kind: "locked", portfolio: t.key });
      continue;
    }
    if (inWindow) {
      ownersPending++;
      continue;
    }
    steps.push(receiptOpen(t.view) ? { kind: "claim-topup", portfolio: t.key } : { kind: "close-resolved", portfolio: t.key });
  }
  // The junior owner's early 101 only helps when nothing else holds the market open: a trader only its owner may close, or an
  // escrowed or locked portfolio, keeps it from terminal-flat, so running 101 early would cost fees and change nothing for the junior.
  if (ownersPending === 0 && blockers.length === 0) steps.unshift(...juniorEarly);

  const terminalFlat = market.materializedPortfolioCount === 0n && market.cTot === 0n;
  // F-14: 78 on a terminal-flat Resolved bound market harvests pending fees AND absorbs the
  // claim-free residual; 77 refuses 84 until it has run. (78 with neither fails NoFeesToCrank.)
  if (terminalFlat && boundVault && ((harvestableAtoms !== null && harvestableAtoms > 0n) || residual > 0n)) {
    return { phase: "sweep", steps: [{ kind: "harvest" }], blockers };
  }
  if (terminalFlat) return { phase: "ready", blockers };
  if (inWindow) return { phase: "owner-window", untilSlot: windowEnd, steps, blockers, ...(ownersPending > 0 ? { ownersPending } : {}) };
  return { phase: "sweep", steps, blockers };
}

/**
 * Per-step compute budget. Builder figures on the final wrapper (3245e861): CloseResolved up to
 * 204k, 101 SettleVaultLpResolved up to 285k. Measured on real BPF by the app's own "Finish now"
 * chain (p3_vault_lp limits_app_p3_finish_now_one_approval, LIMITS_FINISH_MEASURE=1): 101 281,529;
 * CloseResolved 151,044 / 104,931; ClosePortfolio (resolved, empty) 122,469 — NOT small: the
 * first budget of 60k was refused in the sim; 78 harvest 31,479; 76 34,933. Headroom on each.
 * Wrapper 5544302a, after a price move (limits_app_p3_partial_receipt_topup_after_101,
 * LIMITS_FINISH_MEASURE=1): 101 up to 425,253 (a vault LP that won) and CloseResolved up to
 * 301,288 — both over the old 320k / 240k, which the sim refused at the app's budget. The 46
 * top-up runs the same payout path as CloseResolved.
 */
export const EXIT_STEP_CU: Record<ExitStep["kind"], number> = {
  "settle-vault-lp": 520_000,
  "close-resolved": 380_000,
  "claim-topup": 380_000,
  "close-empty": 180_000,
  harvest: 120_000,
};
/** One tx never asks for more than this (the Solana limit is 1.4M). */
export const EXIT_TX_CU_CAP = 1_200_000;

export const exitStepsCu = (steps: readonly ExitStep[]): number =>
  Math.min(EXIT_TX_CU_CAP, steps.reduce((a, s) => a + EXIT_STEP_CU[s.kind], 20_000));

/**
 * Group steps into transactions: at most `perTx` portfolio steps each AND at most EXIT_TX_CU_CAP of
 * summed step budgets (three 101s used to share one fixed 600k tx). Order is preserved.
 */
export function batchExitSteps(steps: readonly ExitStep[], perTx = 3): ExitStep[][] {
  const out: ExitStep[][] = [];
  let cur: ExitStep[] = [];
  let cu = 20_000;
  for (const s of steps) {
    const c = EXIT_STEP_CU[s.kind];
    if (cur.length > 0 && (cur.length >= perTx || cu + c > EXIT_TX_CU_CAP)) {
      out.push(cur);
      cur = [];
      cu = 20_000;
    }
    cur.push(s);
    cu += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Can this plan's steps take the market to terminal-flat NOW (so the junior's 102 opens right after)? Not while a portfolio is
 * escrowed or locked, nor inside the owner window while a trader only its owner may close is still open (on devnet 5S7h2kKg a third
 * party's portfolio keeps the junior waiting for the window whatever the junior runs). After the window every step is
 * permissionless; each one is still simulated before the wallet opens.
 */
export function canFinishNow(plan: ResolvedExitPlan): boolean {
  if (plan.phase !== "sweep" && plan.phase !== "owner-window") return false;
  if (plan.steps.length === 0 || plan.blockers.length > 0) return false;
  return plan.phase === "sweep" || (plan.ownersPending ?? 0) === 0;
}

/** What the Earn panel says about a resolved market (pure; copy in ./copy). */
export interface ResolvedExitSummary {
  phase: ResolvedExitPlan["phase"];
  /** Steps anyone can run right now (the button is enabled iff > 0). */
  runnable: number;
  untilSlot: bigint | null;
  escrowed: number;
  locked: number;
}

export function summarizeResolvedExit(plan: ResolvedExitPlan): ResolvedExitSummary {
  if (plan.phase === "not-resolved") return { phase: plan.phase, runnable: 0, untilSlot: null, escrowed: 0, locked: 0 };
  const steps = plan.phase === "ready" ? [] : plan.steps;
  return {
    phase: plan.phase,
    runnable: steps.length,
    untilSlot: plan.phase === "owner-window" ? plan.untilSlot : null,
    escrowed: plan.blockers.filter((b) => b.kind === "escrowed").length,
    locked: plan.blockers.filter((b) => b.kind === "locked").length,
  };
}
