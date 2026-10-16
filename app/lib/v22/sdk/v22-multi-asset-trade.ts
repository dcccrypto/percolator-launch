/**
 * Q-7 (2026-10-12): the transaction shape for trading on a MULTI-ASSET v2.2 market once a portfolio holds
 * >= 3 legs.
 *
 * Wrapper RC 6c078a0e, `ensure_trade_portfolio_current_for_requests_view` (v16_program.rs:40913, called for
 * account_a AND account_b): a trade portfolio with >= `WRAPPER_PRE_CRANK_MIN_LEGS` (= max(cap - 1, 1) = 3)
 * active legs must hold a health certificate at the market's CURRENT (oracle, funding, risk, asset-set) epochs,
 * else the trade (opens AND closes) returns 19 EngineStale. A refresh crank that settles PnL bumps the market
 * risk epoch, so refreshing the taker invalidates the LP's certificate and vice versa. The shape that satisfies
 * it, in ONE transaction (ledger v22-devnet-fresh §7c; reference script percolator-ops
 * relaunch/v22/fresh/q7-multi-asset-trade.ts @ 1a117658):
 *
 *   [ PermissionlessCrank(LP, observations = every asset)   accrue + certify the LP
 *     PermissionlessCrank(peer, [])  x n                    OPEN only: other positioned portfolios stale on the asset (else 121)
 *     PermissionlessCrank(taker, [])                        settle + certify the taker (bumps the risk epoch)
 *     PermissionlessCrank(LP, [])                           re-certify the LP at the new epoch
 *     TradeCpi ]
 *
 * with a 1,400,000 CU limit (measured 1.13M - 1.38M at 3-4 legs) and the wrapper heap. Client rules: simulate
 * first; drop a crank refused 22 (already current); if the trade is still 19 append one more refresh (taker,
 * then LP, alternating) — {@link refineMultiAssetTradePlanV22} applies them.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
// App port of percolator-sdk feat/v22-sdk @ 418f0cd src/solana/v22-multi-asset-trade.ts: verbatim, only the imports are
// retargeted at the installed @percolatorct/sdk 8.0.0 and the sibling v2.2 ports (see ./index.ts).
import { ACCOUNTS_PERMISSIONLESS_CRANK_BASE, buildAccountMetas, encodePermissionlessCrank } from "@percolatorct/sdk";
import { resolveMarketGeometry } from "./layout";
import { WRAPPER_MAX_PORTFOLIO_ASSETS_V22 } from "./v22-wire";
import { parsePortfolioV17 } from "./slab";
import { computeBudgetPrelude } from "./v22";

/** `WRAPPER_PRE_CRANK_MIN_LEGS`: active legs at which a trade portfolio needs a current health certificate (3). */
export const WRAPPER_PRE_CRANK_MIN_LEGS_V22 = WRAPPER_MAX_PORTFOLIO_ASSETS_V22 > 1 ? WRAPPER_MAX_PORTFOLIO_ASSETS_V22 - 1 : 1;
/** Compute-unit limit for the multi-asset trade shape (measured 1,126,791 - 1,376,127 CU at 3-4 legs on devnet). */
export const MULTI_ASSET_TRADE_COMPUTE_UNITS_V22 = 1_400_000;
/** Extra refresh cranks {@link refineMultiAssetTradePlanV22} may append when the trade is still refused 19. */
export const MULTI_ASSET_TRADE_MAX_EXTRA_CRANKS_V22 = 4;

/** One refresh crank of the plan. */
export interface MultiAssetCrankV22 {
  role: "lpObserve" | "peer" | "taker" | "lp";
  portfolio: PublicKey;
  /** Asset indices observed by this crank (empty = refresh only). */
  observations: number[];
}

/** Inputs of {@link buildMultiAssetTradeIxsV22}. */
export interface MultiAssetTradeInputV22 {
  /** Wrapper program id. */
  programId: PublicKey;
  market: PublicKey;
  /** Raw market account bytes (for the number of asset slots). */
  marketData: Uint8Array;
  /** Signer of the cranks (the taker's wallet; any signer works, the crank is permissionless). */
  cranker: PublicKey;
  takerPortfolio: PublicKey;
  /** Raw taker portfolio bytes. */
  takerData: Uint8Array;
  lpPortfolio: PublicKey;
  /** Raw LP portfolio bytes. */
  lpData: Uint8Array;
  /** The TradeCpi / TradeNoCpi instruction to run after the refreshes (built by the caller). */
  tradeIx: TransactionInstruction;
  /** For an OPEN: other positioned portfolios that are stale on the traded asset (each gets a refresh; else 121). */
  stalePeers?: readonly PublicKey[];
  /** Assets the first LP crank observes. Default: every configured asset slot of the market. */
  observeAssets?: readonly number[];
  /** Force the path instead of deciding from the leg counts. */
  forcePath?: "simple" | "multiAsset";
}

/** The plan: what to send and why. */
export interface MultiAssetTradePlanV22 {
  /** `simple`: single-asset market or both portfolios below 3 legs (no refresh needed); `multiAsset`: the Q-7 shape. */
  path: "simple" | "multiAsset";
  programId: PublicKey;
  market: PublicKey;
  cranker: PublicKey;
  takerPortfolio: PublicKey;
  lpPortfolio: PublicKey;
  /** Refresh cranks, in order (empty on the simple path). */
  cranks: MultiAssetCrankV22[];
  tradeIx: TransactionInstruction;
  /** ComputeBudget instructions (heap + unit limit); empty on the simple path (use your usual trade budget). */
  budgetIxs: TransactionInstruction[];
  /** `[...budgetIxs, ...cranks, tradeIx]`, ready for one transaction. */
  instructions: TransactionInstruction[];
  /** Compute-unit limit requested (undefined on the simple path). */
  computeUnitLimit?: number;
  /** Facts behind the decision. */
  marketSlots: number;
  takerActiveLegs: number;
  lpActiveLegs: number;
  /** Extra refreshes appended by {@link refineMultiAssetTradePlanV22} so far. */
  extraCranks: number;
}

/**
 * Build one PermissionlessCrank (tag 5) refresh of `portfolio`, observing `observations`.
 *
 * @param programId     Wrapper program id.
 * @param market        Market account.
 * @param cranker       Signer.
 * @param portfolio     Portfolio to refresh.
 * @param observations  Asset indices to observe (empty = refresh only).
 * @returns The instruction.
 * @example
 * ```ts
 * const ix = buildRefreshCrankIxV22(programId, market, wallet, lpPortfolio, [0, 1, 2, 3, 4]);
 * ```
 */
export function buildRefreshCrankIxV22(programId: PublicKey, market: PublicKey, cranker: PublicKey, portfolio: PublicKey, observations: readonly number[] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, { owner: cranker, market, portfolio }),
    data: Buffer.from(encodePermissionlessCrank({ nowSlot: 0n, observations: observations.map((assetIndex) => ({ assetIndex, oracleAccounts: 0 })) })),
  });
}

function assemble(base: Omit<MultiAssetTradePlanV22, "instructions" | "budgetIxs" | "computeUnitLimit">): MultiAssetTradePlanV22 {
  const multi = base.path === "multiAsset";
  const budgetIxs = multi ? computeBudgetPrelude(MULTI_ASSET_TRADE_COMPUTE_UNITS_V22) : [];
  const crankIxs = base.cranks.map((c) => buildRefreshCrankIxV22(base.programId, base.market, base.cranker, c.portfolio, c.observations));
  return { ...base, budgetIxs, instructions: [...budgetIxs, ...crankIxs, base.tradeIx], ...(multi ? { computeUnitLimit: MULTI_ASSET_TRADE_COMPUTE_UNITS_V22 } : {}) };
}

/**
 * Build the instruction sequence for a trade (open or close) from the market, taker and LP state. On a
 * multi-asset market where the taker or the LP holds >= 3 legs it returns the Q-7 shape
 * `[budget, crank LP (observe all), crank peers, crank taker, crank LP, trade]` with the 1.4M CU limit;
 * on a single-asset market, or with both below 3 legs, it returns the trade alone (`path: "simple"`).
 * Simulate the result and pass a failure to {@link refineMultiAssetTradePlanV22}.
 *
 * @param i  See {@link MultiAssetTradeInputV22}.
 * @returns The plan; send `plan.instructions` in one transaction.
 * @example
 * ```ts
 * let plan = buildMultiAssetTradeIxsV22({ programId, market, marketData, cranker: wallet, takerPortfolio, takerData, lpPortfolio, lpData, tradeIx });
 * for (let n = 0; n < 8; n++) {
 *   const sim = await simulate(plan.instructions);
 *   if (!sim.value.err) break;
 *   const next = refineMultiAssetTradePlanV22(plan, sim.value.err);
 *   if (next.action === "fail") throw new Error(parseErrorFromLogs(sim.value.logs ?? [], { context: { action: "trade", healthCheckStale: true } })?.hint);
 *   if (next.action === "wait") await sleep(700);
 *   plan = next.plan;
 * }
 * ```
 */
export function buildMultiAssetTradeIxsV22(i: MultiAssetTradeInputV22): MultiAssetTradePlanV22 {
  const g = resolveMarketGeometry(i.marketData, { parser: "buildMultiAssetTradeIxsV22", strictLength: false });
  const marketSlots = new DataView(i.marketData.buffer, i.marketData.byteOffset, i.marketData.byteLength).getUint32(g.groupOff + g.layout.group.config + g.layout.group.maxMarketSlotsInConfig, true);
  const takerActiveLegs = parsePortfolioV17(i.takerData).legs.filter((l) => l.active).length;
  const lpActiveLegs = parsePortfolioV17(i.lpData).legs.filter((l) => l.active).length;
  const needs = marketSlots > 1 && Math.max(takerActiveLegs, lpActiveLegs) >= WRAPPER_PRE_CRANK_MIN_LEGS_V22;
  const path = i.forcePath ?? (needs ? "multiAsset" : "simple");
  const observe = i.observeAssets ? [...i.observeAssets] : Array.from({ length: marketSlots }, (_, k) => k);
  const cranks: MultiAssetCrankV22[] = path === "simple" ? [] : [
    { role: "lpObserve", portfolio: i.lpPortfolio, observations: observe },
    ...(i.stalePeers ?? []).filter((p) => !p.equals(i.takerPortfolio) && !p.equals(i.lpPortfolio)).map((p): MultiAssetCrankV22 => ({ role: "peer", portfolio: p, observations: [] })),
    { role: "taker", portfolio: i.takerPortfolio, observations: [] },
    { role: "lp", portfolio: i.lpPortfolio, observations: [] },
  ];
  return assemble({ path, programId: i.programId, market: i.market, cranker: i.cranker, takerPortfolio: i.takerPortfolio, lpPortfolio: i.lpPortfolio, cranks, tradeIx: i.tradeIx, marketSlots, takerActiveLegs, lpActiveLegs, extraCranks: 0 });
}

/** What to do after a failed simulation of a plan. */
export type MultiAssetTradeRefinementV22 =
  | { action: "retry"; plan: MultiAssetTradePlanV22; reason: string }
  | { action: "wait"; plan: MultiAssetTradePlanV22; reason: string }
  | { action: "fail"; plan: MultiAssetTradePlanV22; code: number | null; reason: string };

/**
 * Apply the client rules to a failed simulation of `plan.instructions`:
 *   - a refresh crank refused 22 (already current) is dropped — except the first, observing crank: wait a slot and retry;
 *   - the trade refused 19 gets one more refresh appended (taker, then LP, alternating; at most 4);
 *   - a 19 on the simple path is a failure here: rebuild the plan from fresh account data;
 *   - anything else is a real refusal.
 *
 * @param plan  The plan that was simulated.
 * @param err   `simulateTransaction(...).value.err` (e.g. `{ InstructionError: [4, { Custom: 22 }] }`).
 * @returns `retry` with the adjusted plan, `wait` (retry the same plan after ~1 slot), or `fail`.
 * @example
 * ```ts
 * const next = refineMultiAssetTradePlanV22(plan, sim.value.err);
 * ```
 */
export function refineMultiAssetTradePlanV22(plan: MultiAssetTradePlanV22, err: unknown): MultiAssetTradeRefinementV22 {
  const ie = (err as { InstructionError?: [number, unknown] } | null | undefined)?.InstructionError;
  const inner = ie?.[1];
  const code = typeof inner === "object" && inner !== null && typeof (inner as { Custom?: unknown }).Custom === "number" ? (inner as { Custom: number }).Custom : null;
  if (!ie) return { action: "fail", plan, code, reason: "not an instruction error" };
  const at = ie[0] - plan.budgetIxs.length; // index among [cranks..., trade]
  const base = { path: plan.path, programId: plan.programId, market: plan.market, cranker: plan.cranker, takerPortfolio: plan.takerPortfolio, lpPortfolio: plan.lpPortfolio, tradeIx: plan.tradeIx, marketSlots: plan.marketSlots, takerActiveLegs: plan.takerActiveLegs, lpActiveLegs: plan.lpActiveLegs };
  if (code === 22 && at >= 0 && at < plan.cranks.length) {
    if (at === 0 && plan.cranks[0]!.role === "lpObserve") return { action: "wait", plan, reason: "the market was already accrued this slot; retry next slot" };
    const cranks = plan.cranks.filter((_, k) => k !== at);
    return { action: "retry", plan: assemble({ ...base, cranks, extraCranks: plan.extraCranks }), reason: `crank ${at} (${plan.cranks[at]!.role}) is already current; dropped` };
  }
  if (code === 19 && at === plan.cranks.length && plan.path === "multiAsset" && plan.extraCranks < MULTI_ASSET_TRADE_MAX_EXTRA_CRANKS_V22) {
    const extra: MultiAssetCrankV22 = plan.extraCranks % 2 === 0 ? { role: "taker", portfolio: plan.takerPortfolio, observations: [] } : { role: "lp", portfolio: plan.lpPortfolio, observations: [] };
    return { action: "retry", plan: assemble({ ...base, cranks: [...plan.cranks, extra], extraCranks: plan.extraCranks + 1 }), reason: `health check still out of date; appended a ${extra.role} refresh` };
  }
  return { action: "fail", plan, code, reason: code === null ? "refused" : `refused with ${code}` };
}
