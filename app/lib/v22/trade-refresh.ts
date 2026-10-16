/**
 * v2.2 QA U-1 / R-1 / Q-7b: the refresh cranks a trade needs in its own transaction.
 *
 * Two program rules the app did not satisfy (wrapper RC 6c078a0e):
 *  - 121 EngineLossStale: a risk-increasing order is refused while another POSITIONED portfolio on the market is
 *    stale and insurance does not cover its hidden-loss bound. The app only waited for the keeper's sweep, so an
 *    open hung on "Refreshing positions" for as long as the peer stayed stale. A PermissionlessCrank of the stale
 *    peer in the same transaction clears it (QA R-1: the swordcat open landed once the standing long was cranked).
 *  - 19 EngineStale on a MULTI-ASSET market once the taker or the LP holds >= 3 legs: both need a health certificate
 *    at the market's current epochs. The shape is the SDK's `buildMultiAssetTradeIxsV22` (port of percolator-sdk
 *    418f0cd): [crank LP observing every asset, crank stale peers, crank taker, crank LP, trade], refined by
 *    `refineMultiAssetTradePlanV22` (drop a crank refused 22, append on a 19).
 *
 * FRESH-TAKER FIX (2026-10-15, measured on a LiteSVM clone of the 4-leg multi-asset market): on a multi-asset market
 * (asset slots > 1) the Q-7 shape above is WRONG for a fresh taker. It STARTS with an observing crank whose accrual
 * moves K on every asset whose mark moved and re-stales every positioned portfolio, so the open gets 121 unless every
 * peer is refreshed in the same tx, and then the LP is refreshed twice and the tx needs ~1.65M CU. A trade does not need
 * an accrual in its own tx. `executeV22MultiAssetOrder` is the multi-asset flow: the body ALONE first; on a 121 / 19
 * the refresh set (stale peers, the taker at >= 3 legs, the LP LAST) with ONE observing crank FIRST over every asset
 * slot; one tx when it simulates under 1.2M CU, else the cranks as their own tx(s) and then the body alone. An
 * observing crank is never part of the body tx. `planV22TradeRefresh` below keeps the single-asset behaviour.
 *
 * This module plans those cranks by SIMULATION (nothing is signed), bounded by a round limit and a peer limit; the
 * caller sends `[...cranks, ...body]` through sendTx, which sizes the compute limit from its own simulation (up to
 * the 1.4M transaction maximum). Pure orchestration: every RPC is a dependency, so the rules are unit-tested.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { buildRefreshCrankIxV22, resolveMarketGeometry, v22Slab, WRAPPER_PRE_CRANK_MIN_LEGS_V22 } from "./sdk";

/** Stale peers refreshed in one transaction (each ~114k CU and one more account; 6 keeps the tx inside 1.4M CU / 1,232 B). */
export const MAX_PEER_CRANKS = 6;
/** Simulation rounds before the plan gives up. */
export const MAX_REFRESH_ROUNDS = 10;
/** One transaction carrying cranks AND the order must simulate at or under this (measured: 1.32-1.34M is too tight). */
export const MULTI_ASSET_ONE_TX_MAX_CU = 1_200_000;
/** Repeats of the refresh-then-body cycle after the first one when the body is still refused 121 / 19. */
export const MAX_TWO_TX_REPEATS = 2;
export const ERR_ENGINE_STALE = 19;
export const ERR_NON_PROGRESS = 22;
export const ERR_LOSS_STALE = 121;

export interface RefreshSim {
  err: unknown;
  logs: readonly string[];
  /** The full simulated list (budget instructions included), for attributing the failing instruction. */
  simulated?: readonly TransactionInstruction[];
  /** Compute units the simulation consumed (null / absent when it failed or is unknown). */
  consumed?: number | null;
}

export interface TradeRefreshInput {
  programId: PublicKey;
  market: PublicKey;
  /** Raw market bytes (asset-slot count). */
  marketData: Uint8Array;
  cranker: PublicKey;
  /** The taker's portfolio; null on a first trade that creates it in this transaction. */
  takerPortfolio: PublicKey | null;
  takerData: Uint8Array | null;
  lpPortfolio: PublicKey;
  lpData: Uint8Array | null;
  /** The instructions to run after the cranks; the LAST one is the trade. */
  body: readonly TransactionInstruction[];
}

export interface TradeRefreshDeps {
  /** Simulate `ixs` as the cranker with the wrapper heap + a 1.4M limit. `prefix` = budget instructions it adds in front. */
  simulate: (ixs: TransactionInstruction[]) => Promise<RefreshSim>;
  /** Budget instructions `simulate` puts in front (lib/tx simulateForGate: 2). */
  simPrefix: number;
  /** Stale positioned portfolios of this market, most urgent first (lib/v22/earn-exit staleCandidatesFromAccounts). */
  readStalePeers: () => Promise<PublicKey[]>;
  /** Turn a failed simulation into the error to throw (lib/tx SimulationRefusal). */
  refusal: (sim: RefreshSim, ixs: TransactionInstruction[]) => Error;
  sleep?: (ms: number) => Promise<void>;
}

export interface TradeRefreshPlan {
  path: "simple";
  /** `[...cranks, ...body]`. */
  instructions: TransactionInstruction[];
  /** The cranks in front, by role. */
  cranks: { role: "lpObserve" | "peer" | "taker" | "lp"; portfolio: PublicKey }[];
  rounds: number;
}

/** The multi-asset refusal after every refinement: the account's health check could not be brought current here. */
export class HealthCheckStaleError extends Error {
  constructor(cause: unknown) {
    super("These positions needed more refreshing than fits in one go, so nothing was sent. Try again in a moment.", { cause });
    this.name = "HealthCheckStaleError";
  }
}

/** Asset slots of the market (1 on a single-asset market). null when the bytes are not a known market layout. */
export function marketAssetSlots(marketData: Uint8Array): number | null {
  try {
    const g = resolveMarketGeometry(marketData, { parser: "marketAssetSlots", strictLength: false });
    return new DataView(marketData.buffer, marketData.byteOffset, marketData.byteLength).getUint32(g.groupOff + g.layout.group.config + g.layout.group.maxMarketSlotsInConfig, true);
  } catch {
    return null;
  }
}

function activeLegs(data: Uint8Array | null): number {
  if (!data) return 0;
  try {
    return v22Slab.parsePortfolioV17(data).legs.filter((l) => l.active).length;
  } catch {
    return 0;
  }
}

/** True when the Q-7 shape is needed: a multi-asset market and the taker or the LP at >= 3 legs. */
export function needsMultiAssetShape(i: Pick<TradeRefreshInput, "marketData" | "takerData" | "lpData">): boolean {
  const slots = marketAssetSlots(i.marketData);
  return slots !== null && slots > 1 && Math.max(activeLegs(i.takerData), activeLegs(i.lpData)) >= WRAPPER_PRE_CRANK_MIN_LEGS_V22;
}

function codeAt(err: unknown): { index: number; code: number | null } | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null | undefined)?.InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return null;
  const inner = ie[1] as { Custom?: unknown } | null;
  return { index: ie[0], code: inner && typeof inner === "object" && typeof inner.Custom === "number" ? inner.Custom : null };
}

const sameKey = (a: PublicKey, b: PublicKey | null) => b !== null && a.equals(b);

/**
 * Plan the cranks. `withPeers`: start by reading the stale peers (the caller already saw a 121). Returns the body
 * unchanged (`cranks: []`) when nothing is needed. Throws `deps.refusal(...)` for a refusal no refresh fixes.
 * Single-asset markets only; a multi-asset order goes through `executeV22MultiAssetOrder`.
 */
export async function planV22TradeRefresh(i: TradeRefreshInput, deps: TradeRefreshDeps, opts: { withPeers?: boolean } = {}): Promise<TradeRefreshPlan> {
  const body = [...i.body];
  let peers: PublicKey[] = [];
  let peersRead = false;
  const loadPeers = async (): Promise<boolean> => {
    if (peersRead) return false;
    peersRead = true;
    const all = (await deps.readStalePeers()).filter((p) => !sameKey(p, i.takerPortfolio) && !p.equals(i.lpPortfolio));
    peers = all.slice(0, MAX_PEER_CRANKS);
    return peers.length > 0;
  };
  if (opts.withPeers) await loadPeers();

  // Single-asset market: only stale peers can be needed, and only after a 121. (A multi-asset market never gets here:
  // it goes through executeV22MultiAssetOrder, whose body tx never carries an observing crank.)
  const observeAll = Array.from({ length: Math.max(marketAssetSlots(i.marketData) ?? 1, 1) }, (_, n) => n);
  if (peers.length === 0) return { path: "simple", instructions: body, cranks: [], rounds: 0 };
  let cranks = [...peers];
  for (let round = 1; round <= MAX_REFRESH_ROUNDS; round++) {
    // The FIRST crank observes every asset slot of the market ([0] on a single-asset market): it accrues the market to this slot, and only then is a peer "behind"
    // (a refresh-only crank before any accrual is refused 22: the peer is current against the STORED epoch, and the
    // trade's own accrual is what makes it stale; measured on swordcat 2026-10-12). The rest are refresh-only.
    const ixs = [...cranks.map((p, n) => buildRefreshCrankIxV22(i.programId, i.market, i.cranker, p, n === 0 ? observeAll : [])), ...body];
    const sim = await deps.simulate(ixs);
    if (!sim.err) return { path: "simple", instructions: ixs, cranks: cranks.map((p) => ({ role: "peer" as const, portfolio: p })), rounds: round };
    const at = codeAt(sim.err);
    const j = at ? at.index - deps.simPrefix : -1;
    // A peer that is already current (22) is dropped; with none left the body goes alone.
    if (at && at.code === ERR_NON_PROGRESS && j >= 0 && j < cranks.length) {
      cranks = cranks.filter((_, k) => k !== j);
      if (cranks.length === 0) return { path: "simple", instructions: body, cranks: [], rounds: round };
      continue;
    }
    throw deps.refusal(sim, ixs);
  }
  throw deps.refusal({ err: { InstructionError: [0, { Custom: ERR_LOSS_STALE }] }, logs: [] }, body);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Multi-asset order flow (asset slots > 1)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Custom(22) anywhere in the error text: a crank of the refresh prefix was already current when the tx ran. */
export function isRefreshRace(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const logs = Array.isArray((e as { logs?: unknown } | null)?.logs) ? ((e as { logs: unknown[] }).logs).map(String).join("\n") : "";
  return /custom program error: 0x16\b|"Custom":22\b|Custom\(22\)/.test(msg + "\n" + logs);
}

/** The simulation ran out of compute units (the 1.4M transaction maximum). */
export function isComputeExceeded(sim: RefreshSim): boolean {
  const ie = (sim.err as { InstructionError?: [number, unknown] } | null | undefined)?.InstructionError;
  if (ie && typeof ie[1] === "string" && /ProgramFailedToComplete|ComputationalBudgetExceeded/.test(ie[1])) return true;
  return sim.logs.some((l) => /exceeded CUs meter|exceeded maximum number of instructions|Computational budget exceeded/i.test(l));
}

export type MultiAssetSendKind =
  /** The cranks alone (their own tx; sized up to the 1.4M maximum). */
  | "refresh"
  /** The order alone (the usual compute sizing). */
  | "order"
  /** Cranks and the order in one tx (sized up to the 1.4M maximum). */
  | "orderWithRefresh";

export interface MultiAssetOrderInput {
  programId: PublicKey;
  market: PublicKey;
  /** Raw market bytes (asset-slot count). */
  marketData: Uint8Array;
  cranker: PublicKey;
  /** The taker's portfolio; null on a first trade that creates it in the body. */
  takerPortfolio: PublicKey | null;
  takerData: Uint8Array | null;
  lpPortfolio: PublicKey;
  /** The order: [deposit / init ..., trade]; the LAST one is the trade. NO cranks. */
  body: readonly TransactionInstruction[];
}

export interface MultiAssetOrderDeps extends TradeRefreshDeps {
  /** Sign, send and wait for confirmation of ONE transaction; resolves with its signature. */
  send: (ixs: TransactionInstruction[], kind: MultiAssetSendKind) => Promise<string>;
  /** The order needs its cranks as their own transaction(s): the wallet may open more than once. Called once, before tx 1 is sent. */
  onTwoTx?: (txCount: number) => void;
}

export interface MultiAssetOrderResult {
  /** Signature of the transaction that carried the trade. */
  signature: string;
  /** Signatures of the refresh-only transactions sent before it (2-tx path). */
  refreshSignatures: string[];
  path: "bodyAlone" | "oneTx" | "twoTx";
  /** Refresh cycles run (0 = the body went alone). */
  cycles: number;
}

type CrankRole = "lpObserve" | "peer" | "taker" | "lp";
interface Crank { role: CrankRole; portfolio: PublicKey; observe: boolean }

const crankIx = (i: MultiAssetOrderInput, c: Crank, slots: number) =>
  buildRefreshCrankIxV22(i.programId, i.market, i.cranker, c.portfolio, c.observe ? Array.from({ length: slots }, (_, n) => n) : []);

/** The refresh set in order: non-LP portfolios first (the first one observing EVERY asset slot), the LP hint-less and LAST. */
export function buildMultiAssetCranks(nonLp: readonly { role: "peer" | "taker"; portfolio: PublicKey }[], lp: PublicKey): Crank[] {
  if (nonLp.length === 0) return [{ role: "lpObserve", portfolio: lp, observe: true }];
  return [...nonLp.map((c, n): Crank => ({ role: c.role, portfolio: c.portfolio, observe: n === 0 })), { role: "lp", portfolio: lp, observe: false }];
}

/** Split `cranks` (LP last) into `g` transactions: non-LP portfolios chunked, the first of EACH tx observing, the LP last in the LAST. */
function splitCranks(cranks: readonly Crank[], g: number): Crank[][] {
  const lp = cranks[cranks.length - 1];
  const nonLp = cranks.slice(0, -1).filter((c) => c.role !== "lpObserve");
  if (nonLp.length === 0) return [[{ ...lp, role: "lpObserve", observe: true }]];
  const size = Math.ceil(nonLp.length / g);
  const chunks: Crank[][] = [];
  for (let k = 0; k < nonLp.length; k += size) chunks.push(nonLp.slice(k, k + size).map((c, n) => ({ ...c, observe: n === 0 })));
  chunks[chunks.length - 1].push({ ...lp, role: "lp", observe: false });
  return chunks;
}

/**
 * An order on a MULTI-ASSET market (asset slots > 1), first trade or ticket trade. Never puts an observing crank in the
 * transaction that carries the order.
 *  1. Simulate the body alone. OK: send it.
 *  2. Refused 121 (stale peer) or 19 (health certificate out of date): refresh set = stale positioned portfolios,
 *     the taker at >= 3 legs, the LP last. The first non-LP crank observes every asset slot; the LP is hint-less and
 *     last (when the set has nothing else, the LP crank observes every asset). A crank refused 22 is dropped (the
 *     first, observing one: wait a slot and retry).
 *  3. [cranks, body] simulates OK at <= 1.2M CU: one tx.
 *  4. Otherwise the cranks go as their own tx(s) (split across txs when they alone exceed 1.4M), then the body alone is
 *     simulated again and sent. Still 121 / 19: repeat at most MAX_TWO_TX_REPEATS times, then HealthCheckStaleError.
 */
export async function executeV22MultiAssetOrder(i: MultiAssetOrderInput, deps: MultiAssetOrderDeps): Promise<MultiAssetOrderResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = [...i.body];
  const slots = Math.max(marketAssetSlots(i.marketData) ?? 1, 1);
  const tradeIdx = body.length - 1;
  const refreshSignatures: string[] = [];
  const takerLegs = activeLegs(i.takerData);

  /** The trade (the body's last instruction, after `lead` cranks) was refused 121 / 19. */
  const needsRefresh = (sim: RefreshSim, lead = 0): boolean => {
    const at = codeAt(sim.err);
    return at !== null && at.index - deps.simPrefix === lead + tradeIdx && (at.code === ERR_LOSS_STALE || at.code === ERR_ENGINE_STALE);
  };

  /** Simulate `[cranks, tail]`, dropping a crank refused 22 (the first one: wait a slot) until it is not refused 22. */
  const settle = async (start: Crank[], tail: TransactionInstruction[]): Promise<{ cranks: Crank[]; sim: RefreshSim; ixs: TransactionInstruction[] }> => {
    let cranks = start;
    for (let round = 1; round <= MAX_REFRESH_ROUNDS; round++) {
      const ixs = [...cranks.map((c) => crankIx(i, c, slots)), ...tail];
      const sim = await deps.simulate(ixs);
      const at = sim.err ? codeAt(sim.err) : null;
      const j = at ? at.index - deps.simPrefix : -1;
      if (at && at.code === ERR_NON_PROGRESS && j >= 0 && j < cranks.length) {
        if (j === 0) await sleep(700);
        else cranks = cranks.filter((_, k) => k !== j);
        if (cranks.length === 0) return { cranks, sim, ixs: tail };
        continue;
      }
      return { cranks, sim, ixs };
    }
    throw new HealthCheckStaleError(new Error("refresh rounds exhausted"));
  };

  for (let cycle = 0; ; cycle++) {
    // 1. The body alone.
    const first = await deps.simulate(body);
    if (!first.err) {
      const signature = await deps.send(body, "order");
      return { signature, refreshSignatures, path: refreshSignatures.length === 0 ? "bodyAlone" : "twoTx", cycles: cycle };
    }
    if (!needsRefresh(first)) throw deps.refusal(first, body);
    if (cycle > MAX_TWO_TX_REPEATS) throw new HealthCheckStaleError(deps.refusal(first, body));

    // 2. The refresh set.
    const stale = (await deps.readStalePeers()).filter((p) => !sameKey(p, i.takerPortfolio) && !p.equals(i.lpPortfolio)).slice(0, MAX_PEER_CRANKS);
    const nonLp: { role: "peer" | "taker"; portfolio: PublicKey }[] = stale.map((portfolio) => ({ role: "peer", portfolio }));
    if (i.takerPortfolio && takerLegs >= WRAPPER_PRE_CRANK_MIN_LEGS_V22) nonLp.push({ role: "taker", portfolio: i.takerPortfolio });
    const cranks = buildMultiAssetCranks(nonLp, i.lpPortfolio);

    // 3. One tx when [cranks, body] simulates OK at <= 1.2M CU.
    const one = await settle(cranks, body);
    if (!one.sim.err && typeof one.sim.consumed === "number" && one.sim.consumed <= MULTI_ASSET_ONE_TX_MAX_CU) {
      try {
        const signature = await deps.send(one.ixs, "orderWithRefresh");
        return { signature, refreshSignatures, path: "oneTx", cycles: cycle + 1 };
      } catch (e) {
        if (!isRefreshRace(e)) throw e;
        await sleep(700); // a same-slot race: back to the body alone from fresh state
        continue;
      }
    }
    if (one.cranks.length > 0 && one.sim.err && !isComputeExceeded(one.sim) && !needsRefresh(one.sim, one.cranks.length)) throw deps.refusal(one.sim, one.ixs);

    // 4. Two transactions: the cranks, then the body alone.
    const settled = one.cranks;
    let txs: Crank[][] = [settled];
    if (settled.length > 0) {
      const maxG = Math.max(settled.filter((c) => c.role !== "lp" && c.role !== "lpObserve").length, 1);
      txs = [];
      for (let g = 1; g <= maxG; g++) {
        const cand = splitCranks(settled, g);
        let fits = true;
        for (const chunk of cand) {
          if (isComputeExceeded(await deps.simulate(chunk.map((c) => crankIx(i, c, slots))))) { fits = false; break; }
        }
        if (fits) { txs = cand; break; }
      }
      if (txs.length === 0) throw new HealthCheckStaleError(new Error("refresh cranks do not fit in a transaction"));
    }
    if (txs.length > 0 && txs[0].length > 0) deps.onTwoTx?.(txs.length + 1);
    for (const chunk of txs) {
      if (chunk.length === 0) continue;
      const r = await settle(chunk, []);
      if (r.sim.err) throw deps.refusal(r.sim, r.ixs);
      if (r.cranks.length === 0) continue;
      try {
        refreshSignatures.push(await deps.send(r.ixs, "refresh"));
      } catch (e) {
        // 22 at send: another sender (the keeper) refreshed these in the same slot. The refresh is done either way, so
        // the body is simulated alone again below (still bounded by MAX_TWO_TX_REPEATS); anything else is a refusal.
        if (!isRefreshRace(e)) throw e;
      }
    }
    await sleep(800); // a few slots: the body is simulated against the refreshed state
  }
}
