/**
 * Client self-heal: prepend the two permissionless liveness repairs into the
 * user's OWN transaction when (and only when) the user's transaction would
 * otherwise revert because of them.
 *
 *   ExpireBackingBucket (tag 89)  — a `Fresh` backing bucket whose fixed
 *     expiry has passed. Settling a gain against it reverts EngineStale
 *     Custom(19); reserving a loss / topping up / LP-vault depositing into it
 *     reverts EngineLockActive Custom(21). Observed live 2026-09-29 on PAID,
 *     CATE (d1), COLLECT (d1), Murphy (d0+d1; Earn deposit blocked).
 *   FinalizeResetSide (tag 45)    — a side left `ResetPending` after a full
 *     drain reset with no positions. `asset_risk_increase_gate` rejects every
 *     risk-increasing trade Custom(21) until it runs (COLLECT, Murphy short).
 *
 * Both are market-only, move no tokens, take no caller-chosen slot/amount, and
 * the engine refuses both unless the market really is in the state being
 * repaired — sending one early is a clean revert, never a state change. The
 * keeper does the same repairs (percolator-oracle-keeper #130,
 * `liveness-repair.ts`); this is the client-side redundancy for when the
 * keeper is down or has not reached the market yet.
 *
 * Flow (`planSelfHeal`):
 *   1. Read the market (one getAccountInfo, overlapped with the blockhash fetch
 *      inside sendTx) and decode which repairs the engine WOULD accept now.
 *      Empty plan (the steady state) → nothing else happens: no extra RPC.
 *   2. Simulate the user's transaction unchanged. Passes → unchanged.
 *   3. Fails with Custom(19)/Custom(21) raised by the WRAPPER program → prepend
 *      the repairs, simulate again. If that clears the 19/21, use the repaired
 *      instruction list (if a different error remains, e.g. LP depleted
 *      Custom(49), that is the real diagnosis and sendTx's own simulation
 *      surfaces it). Otherwise → unchanged.
 * Any RPC failure → unchanged (fail to the ordinary path; never guesses).
 *
 * ── Wire formats: DEPLOYED wrapper `deploy/v18.2-wrapper@6377376a`
 *    (`src/v16_program.rs`), NOT the SDK's types ─────────────────────────────
 *   tag 89 decode arm `89 => ExpireBackingBucket { domain: read_u16 }`
 *     → data [89, domain u16 LE]; `handle_expire_backing_bucket`: account 0 =
 *     market (writable, owned by program). No signer. Live-only (mode != 0 →
 *     EngineLockActive); `domain >= max_market_slots*2` → InvalidInstruction;
 *     slot = max(Clock, header.current_slot)
 *     (`authenticated_market_slot_or_fallback_view`).
 *   tag 45 decode arm `45 => FinalizeResetSide { asset_index: read_u16,
 *     side: read_u8 }` → data [45, asset u16 LE, side u8]; `decode_side`
 *     0 = Long, 1 = Short; account 0 = market (writable, owned). No signer.
 *
 * ── Account layout: `examples/dump_layout.rs` run against the deployed tree
 *    (`~/deploycand-v182/percolator-prog@6377376a` + engine `35ddd692`) ──────
 *   HEADER_LEN 16 + WRAPPER_CONFIG_LEN 576 = MARKET_GROUP_OFF 592
 *   MarketGroupV16HeaderAccount (758): config @32 (V16ConfigAccount:
 *     max_portfolio_assets u16 @0, max_market_slots u32 @2), current_slot @613,
 *     mode @626.
 *   market slot stride 2325 = Market<[u8;1024]> { wrapper: [u8;1024], engine:
 *     EngineAssetSlotV16Account (1301) } — engine slot at +1024.
 *   EngineAssetSlotV16Account: asset (AssetStateV16Account 515) @0,
 *     pending_domain_loss_barrier_long/short u64 @579/@587,
 *     backing_long/short (BackingBucketV16Account 97) @963/@1060.
 *   AssetStateV16Account: stored_pos_count_long/short @321/@329,
 *     stale_account_count_long/short @337/@345,
 *     pending_obligation_count_long/short @353/@361, mode_long/short @513/@514.
 *   BackingBucketV16Account: expiry_slot u64 @88, status u8 @96.
 *   BackingBucketStatusV16 { Empty, Fresh, Expired, Impaired } → Fresh = 1.
 *   SideModeV16 { Normal, DrainOnly, ResetPending } → ResetPending = 2.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { AccountMeta, Connection } from "@solana/web3.js";
import { ACCOUNTS_PERMISSIONLESS_CRANK_BASE, buildAccountMetas, buildIx, encodePermissionlessCrank } from "@percolatorct/sdk";
import { defaultCrankObservations } from "@/lib/v18-wire";

import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { decodeAssetVaultLp } from "@/lib/limits/decode";
import {
  STALE_REFRESH_CU,
  buildStaleRefreshIx,
  decodeStaleCohort,
  findStalePortfolios,
  hasStaleCohort,
  type StaleCohort,
} from "@/lib/stale-refresh";
// ── Wire tags (deployed wrapper decode arms) ─────────────────────────────────
export const EXPIRE_BACKING_BUCKET_TAG = 89;
export const FINALIZE_RESET_SIDE_TAG = 45;

// ── Layout (deployed dump_layout; see header) ────────────────────────────────
const MARKET_GROUP_OFF = 592;
const MARKET_GROUP_LEN = 758;
const GROUP_CONFIG_REL = 32;
const CONFIG_MAX_MARKET_SLOTS_REL = 2;
const GROUP_CURRENT_SLOT_REL = 613;
const GROUP_MODE_REL = 626;
const MARKET_ASSET_SLOT_LEN = 2325;
const ASSET_WRAPPER_LEN = 1024;
const AS_STORED_POS = [321, 329] as const;
const AS_STALE = [337, 345] as const;
const AS_PENDING_OBL = [353, 361] as const;
const AS_MODE = [513, 514] as const;
const SLOT_BARRIER = [579, 587] as const;
const SLOT_BACKING = [963, 1060] as const;
const BACKING_BUCKET_LEN = 97;
const BK_EXPIRY = 88;
const BK_STATUS = 96;

export const BUCKET_STATUS_FRESH = 1;
export const SIDE_MODE_RESET_PENDING = 2;
/** Wrapper error codes the repairs can clear (PercolatorError discriminants). */
export const ENGINE_STALE_CODE = WRAPPER_ERR.EngineStale;
export const ENGINE_LOCK_ACTIVE_CODE = WRAPPER_ERR.EngineLockActive;
/** One market-only state transition each (keeper REPAIR_CU). */
export const REPAIR_CU = 40_000;
const MAX_TX_CU = 1_400_000;
/** Never prepend more than this many repairs (2 buckets + 2 sides per asset; cap tx size). */
export const MAX_REPAIRS = 8;

export interface BucketLiveness {
  domain: number;
  status: number;
  expirySlot: bigint;
}

export interface SideLiveness {
  assetIndex: number;
  /** 0 = long, 1 = short (wrapper `decode_side`). */
  side: 0 | 1;
  mode: number;
  storedPos: bigint;
  stale: bigint;
  pendingObligations: bigint;
  pendingDomainLossBarrier: bigint;
}

export interface MarketLiveness {
  /** header.mode — 0 Live. */
  mode: number;
  /** max(readSlot, header.current_slot) — the slot the program itself uses. */
  nowSlot: bigint;
  buckets: BucketLiveness[];
  sides: SideLiveness[];
}

export type LivenessRepair =
  | { kind: "expire"; domain: number }
  | { kind: "finalize"; assetIndex: number; side: 0 | 1 };

function view(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}

/**
 * Decode every addressable asset slot's bucket + side state.
 * `readSlot` is the context slot the account was read at.
 */
export function decodeMarketLiveness(data: Uint8Array, readSlot: bigint): MarketLiveness {
  const slotsBase = MARKET_GROUP_OFF + MARKET_GROUP_LEN;
  if (data.length < slotsBase + ASSET_WRAPPER_LEN + SLOT_BACKING[1] + BACKING_BUCKET_LEN) {
    throw new Error(`decodeMarketLiveness: market account too short (${data.length} bytes)`);
  }
  const dv = view(data);
  const mode = data[MARKET_GROUP_OFF + GROUP_MODE_REL];
  const headerSlot = dv.getBigUint64(MARKET_GROUP_OFF + GROUP_CURRENT_SLOT_REL, true);
  const maxMarketSlots = dv.getUint32(MARKET_GROUP_OFF + GROUP_CONFIG_REL + CONFIG_MAX_MARKET_SLOTS_REL, true);
  const physical = Math.floor((data.length - slotsBase) / MARKET_ASSET_SLOT_LEN);
  const assets = Math.min(maxMarketSlots, physical);
  const nowSlot = readSlot > headerSlot ? readSlot : headerSlot;
  const buckets: BucketLiveness[] = [];
  const sides: SideLiveness[] = [];
  for (let assetIndex = 0; assetIndex < assets; assetIndex++) {
    const e = slotsBase + assetIndex * MARKET_ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
    if (e + SLOT_BACKING[1] + BACKING_BUCKET_LEN > data.length) break;
    for (const s of [0, 1] as const) {
      const b = e + SLOT_BACKING[s];
      buckets.push({
        domain: assetIndex * 2 + s,
        status: data[b + BK_STATUS],
        expirySlot: dv.getBigUint64(b + BK_EXPIRY, true),
      });
      sides.push({
        assetIndex,
        side: s,
        mode: data[e + AS_MODE[s]],
        storedPos: dv.getBigUint64(e + AS_STORED_POS[s], true),
        stale: dv.getBigUint64(e + AS_STALE[s], true),
        pendingObligations: dv.getBigUint64(e + AS_PENDING_OBL[s], true),
        pendingDomainLossBarrier: dv.getBigUint64(e + SLOT_BARRIER[s], true),
      });
    }
  }
  return { mode, nowSlot, buckets, sides };
}

/**
 * The repairs the engine would accept right now. Mirrors the gates exactly:
 *   expire:   header.mode == Live && status == Fresh && now_slot >= expiry
 *             (`expire_source_backing_bucket_not_atomic`)
 *   finalize: mode == ResetPending && stored_pos == stale == pending_obl ==
 *             barrier == 0 (`finalize_side_reset_not_atomic`)
 */
export function planLivenessRepairs(s: MarketLiveness): LivenessRepair[] {
  const out: LivenessRepair[] = [];
  if (s.mode === 0) {
    for (const b of s.buckets) {
      if (b.status === BUCKET_STATUS_FRESH && s.nowSlot >= b.expirySlot) {
        out.push({ kind: "expire", domain: b.domain });
      }
    }
  }
  for (const side of s.sides) {
    if (
      side.mode === SIDE_MODE_RESET_PENDING &&
      side.storedPos === 0n &&
      side.stale === 0n &&
      side.pendingObligations === 0n &&
      side.pendingDomainLossBarrier === 0n
    ) {
      out.push({ kind: "finalize", assetIndex: side.assetIndex, side: side.side });
    }
  }
  return out.slice(0, MAX_REPAIRS);
}

export function encodeExpireBackingBucketData(domain: number): Uint8Array {
  if (!Number.isInteger(domain) || domain < 0 || domain > 0xffff) throw new Error(`bad domain ${domain}`);
  const d = new Uint8Array(3);
  d[0] = EXPIRE_BACKING_BUCKET_TAG;
  view(d).setUint16(1, domain, true);
  return d;
}

export function encodeFinalizeResetSideData(assetIndex: number, side: 0 | 1): Uint8Array {
  if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex > 0xffff) throw new Error(`bad asset ${assetIndex}`);
  const d = new Uint8Array(4);
  d[0] = FINALIZE_RESET_SIDE_TAG;
  view(d).setUint16(1, assetIndex, true);
  d[3] = side;
  return d;
}

export function buildLivenessRepairIx(
  programId: PublicKey,
  market: PublicKey,
  r: LivenessRepair,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: market, isSigner: false, isWritable: true }],
    data: Buffer.from(
      r.kind === "expire" ? encodeExpireBackingBucketData(r.domain) : encodeFinalizeResetSideData(r.assetIndex, r.side),
    ),
  });
}

export function describeRepair(r: LivenessRepair): string {
  return r.kind === "expire"
    ? `ExpireBackingBucket(domain ${r.domain})`
    : `FinalizeResetSide(asset ${r.assetIndex}, ${r.side === 0 ? "long" : "short"})`;
}

/** `{ InstructionError: [index, { Custom: n }] }` → { index, code }. */
export function parseCustomInstructionError(err: unknown): { index: number; code: number } | null {
  if (!err || typeof err !== "object") return null;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2 || typeof ie[0] !== "number") return null;
  const inner = ie[1] as { Custom?: unknown } | null;
  if (!inner || typeof inner !== "object" || typeof inner.Custom !== "number") return null;
  return { index: ie[0], code: inner.Custom };
}

/**
 * True iff the simulation failed with Custom(19)/Custom(21) raised by an
 * instruction of the WRAPPER program. `txInstructions` is the exact list the
 * simulated transaction carried, in order. Code-overlap guard: the matcher,
 * stake and SPL programs all have their own Custom(19)/(21).
 */
export function isRepairableFailure(
  err: unknown,
  txInstructions: readonly TransactionInstruction[],
  wrapperProgramId: PublicKey,
): boolean {
  const p = parseCustomInstructionError(err);
  if (!p) return false;
  if (p.code !== ENGINE_STALE_CODE && p.code !== ENGINE_LOCK_ACTIVE_CODE) return false;
  const ix = txInstructions[p.index];
  return !!ix && ix.programId.equals(wrapperProgramId);
}

/**
 * GH#2953: a healed list is only kept when it simulates clean, or when what still fails is the
 * user's OWN instruction (index >= firstUserIndex) with a non-19/21 code: the real diagnosis.
 * A repair that is itself refused (e.g. a stale refresh refused EngineNonProgress 22 because a
 * new mark arrived in between) must never replace the user's 19/21 with its own error.
 */
export function healedListUsable(
  err: unknown,
  list: readonly TransactionInstruction[],
  wrapperProgramId: PublicKey,
  firstUserIndex: number,
): boolean {
  if (!err) return true;
  if (isRepairableFailure(err, list, wrapperProgramId)) return false;
  const p = parseCustomInstructionError(err);
  const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
  const index = p?.index ?? (Array.isArray(ie) && typeof ie[0] === "number" ? ie[0] : null);
  return index !== null && index >= firstUserIndex;
}

/** The compute-budget prefix sendTx puts in front of every transaction. */
export function computeBudgetPrefix(computeUnits: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
  ];
}

export interface SimResult {
  err: unknown;
}

export interface SelfHealDeps {
  /** Market bytes + the slot they were read at, or null when missing. */
  readMarket: () => Promise<{ data: Uint8Array; slot: bigint } | null>;
  /** Simulate a full instruction list (compute-budget prefix included). */
  simulate: (instructions: TransactionInstruction[]) => Promise<SimResult>;
  /** GH#2953: the market's stale-cohort portfolios (lib/stale-refresh.ts); [] = none / too many. */
  findStaleRefreshes?: (programId: PublicKey, cohort: StaleCohort) => Promise<PublicKey[]>;
}

export interface SelfHealParams {
  programId: PublicKey;
  market: PublicKey;
  instructions: TransactionInstruction[];
  computeUnits: number;
  /**
   * UX WP-2 (SH-2): when set, a wrapper 19/21 caused by the engine clock lagging is repaired by
   * prepending `k` PermissionlessCrank instructions of `portfolio` (the market's LP; the
   * bound vault LP on P3 when null), each accruing up to max_accrual_dt_slots.
   */
  catchUp?: { cranker: PublicKey; portfolio: PublicKey | null; oracleTail?: readonly AccountMeta[] };
  /**
   * GH#2953: when set and the market has a stale K/F cohort, a wrapper 19/21 is repaired by
   * prepending a no-observation refresh crank (signed by this cranker) of each stale portfolio.
   */
  staleRefreshCranker?: PublicKey;
}

/**
 * One catch-up crank of the vault LP, measured in LiteSVM (scripts/limits-parity/p3-sim
 * `limits_app_catch_up_cranks_then_trade`): 17,010 CU on p3-batched-4b1a5d30, 20,846 CU on
 * ede691b6 (the worse-of build). Budgeted with ~20% headroom over the newer figure.
 */
export const CATCH_UP_CRANK_CU = 25_000;
/** Total CU the repairs + the user's own instructions may reach (SH-2 cap). */
export const CATCH_UP_TOTAL_CU = 1_200_000;

export interface CatchUpPlan {
  /** Cranks to prepend (0 = none needed / not possible). */
  k: number;
  lagSlots: bigint;
  dtSlots: bigint | null;
  /** The lag needs more cranks than the CU budget allows: the keeper must catch up (SH-3). */
  beyondCap: boolean;
}

/**
 * SH-2: how many catch-up cranks bring asset 0's engine clock (`slot_last`) to `nowSlot`.
 * Each crank accrues at most `max_accrual_dt_slots`, so k = ceil(lag / dt) (at least 1 when
 * lagging). Capped so `userCu + k * CATCH_UP_CRANK_CU <= CATCH_UP_TOTAL_CU`.
 */
/** AssetStateV16Account.slot_last within the engine asset slot (lib/v17-engine-clock.ts: 41). */
const ASSET_SLOT_LAST_REL = 41;
/** V16ConfigAccount.max_accrual_dt_slots within the config block (lib/v17-engine-clock.ts: 118). */
const CONFIG_MAX_ACCRUAL_DT_REL = 118;

/** Local readers (no SDK constants at import time: this module is loaded by sendTx everywhere). */
function readSlotLast(d: Uint8Array): bigint | null {
  const off = MARKET_GROUP_OFF + MARKET_GROUP_LEN + ASSET_WRAPPER_LEN + ASSET_SLOT_LAST_REL;
  if (off + 8 > d.length) return null;
  const v = view(d).getBigUint64(off, true);
  return v > 0n ? v : null;
}
function readMaxAccrualDt(d: Uint8Array): bigint | null {
  const off = MARKET_GROUP_OFF + GROUP_CONFIG_REL + CONFIG_MAX_ACCRUAL_DT_REL;
  if (off + 8 > d.length) return null;
  const v = view(d).getBigUint64(off, true);
  return v > 0n ? v : null;
}

export function planCatchUp(data: Uint8Array, readSlot: bigint, userCu: number): CatchUpPlan {
  const slotLast = readSlotLast(data);
  const dt = readMaxAccrualDt(data);
  const headerSlot = data.length >= MARKET_GROUP_OFF + GROUP_CURRENT_SLOT_REL + 8 ? view(data).getBigUint64(MARKET_GROUP_OFF + GROUP_CURRENT_SLOT_REL, true) : 0n;
  const now = readSlot > headerSlot ? readSlot : headerSlot;
  if (slotLast === null || dt === null || now <= slotLast) return { k: 0, lagSlots: 0n, dtSlots: dt, beyondCap: false };
  const lag = now - slotLast;
  const k = Number((lag + dt - 1n) / dt);
  const kMax = Math.max(0, Math.floor((CATCH_UP_TOTAL_CU - userCu) / CATCH_UP_CRANK_CU));
  return k > kMax ? { k: 0, lagSlots: lag, dtSlots: dt, beyondCap: true } : { k: Math.max(1, k), lagSlots: lag, dtSlots: dt, beyondCap: false };
}

/** The catch-up crank the keeper sends: [cranker, market, portfolio, ...oracle tail], nowSlot 0. */
export function buildCatchUpCrankIx(programId: PublicKey, cranker: PublicKey, market: PublicKey, portfolio: PublicKey, oracleTail: readonly AccountMeta[] = []): TransactionInstruction {
  const keys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [cranker, market, portfolio]);
  for (const k of oracleTail) keys.push(k);
  return buildIx({ programId, keys, data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }) });
}

export type SelfHealOutcome =
  | "no-repair-needed"
  | "user-tx-ok"
  | "not-repairable"
  | "repaired"
  | "repair-did-not-help"
  | "rpc-error";

export interface SelfHealResult {
  instructions: TransactionInstruction[];
  computeUnits: number;
  repairs: LivenessRepair[];
  outcome: SelfHealOutcome;
  /** Catch-up cranks included (SH-2); 0 when none. */
  catchUpCranks?: number;
  /** The engine clock lags past the catch-up cap (SH-3: the keeper must catch up). */
  catchUpBeyondCap?: boolean;
  /** GH#2953: stale-cohort refresh cranks included; 0 / absent when none. */
  staleRefreshes?: number;
}

/** See the module header for the flow. Never throws. */
export async function planSelfHeal(params: SelfHealParams, deps: SelfHealDeps): Promise<SelfHealResult> {
  const unchanged = (outcome: SelfHealOutcome, extra: Partial<SelfHealResult> = {}): SelfHealResult => ({
    instructions: params.instructions,
    computeUnits: params.computeUnits,
    repairs: [],
    outcome,
    ...extra,
  });
  try {
    const acct = await deps.readMarket();
    if (!acct) return unchanged("no-repair-needed");
    const repairs = planLivenessRepairs(decodeMarketLiveness(acct.data, acct.slot));
    // SH-2: catch-up cranks for a lagging engine clock (only when the caller opted in).
    const catchUp = params.catchUp ? planCatchUp(acct.data, acct.slot, params.computeUnits + REPAIR_CU * repairs.length) : null;
    let crankPortfolio: PublicKey | null = params.catchUp?.portfolio ?? null;
    if (params.catchUp && !crankPortfolio) {
      const rec = decodeAssetVaultLp(acct.data, 0);
      crankPortfolio = rec?.bound ? new PublicKey(rec.vaultLpPortfolio) : null;
    }
    const cranks = catchUp && catchUp.k > 0 && crankPortfolio ? catchUp.k : 0;
    const beyondCap = catchUp?.beyondCap === true;
    // GH#2953: a stale K/F cohort locks every risk-increasing trade (lib/stale-refresh.ts).
    const cohort = params.staleRefreshCranker && deps.findStaleRefreshes ? decodeStaleCohort(acct.data) : null;
    const staleOn = hasStaleCohort(cohort);
    if (repairs.length === 0 && cranks === 0 && !staleOn) return unchanged("no-repair-needed", { catchUpBeyondCap: beyondCap });

    const prefixOrig = computeBudgetPrefix(params.computeUnits);
    const origList = [...prefixOrig, ...params.instructions];
    const orig = await deps.simulate(origList);
    if (!orig.err) return unchanged("user-tx-ok");
    if (!isRepairableFailure(orig.err, origList, params.programId)) return unchanged("not-repairable");

    // Stale-cohort refreshes first, WITHOUT catch-up cranks: an accrual in front of them would
    // move K/F again and re-stale every positioned portfolio.
    if (staleOn && cohort && deps.findStaleRefreshes && params.staleRefreshCranker) {
      const stale = await deps.findStaleRefreshes(params.programId, cohort);
      if (stale.length > 0) {
        const refreshIxs = stale.map((pf) => buildStaleRefreshIx(params.programId, params.staleRefreshCranker!, params.market, pf));
        const libIxs = repairs.map((r) => buildLivenessRepairIx(params.programId, params.market, r));
        const cu = Math.min(MAX_TX_CU, params.computeUnits + REPAIR_CU * repairs.length + STALE_REFRESH_CU * refreshIxs.length);
        const ixs = [...libIxs, ...refreshIxs, ...params.instructions];
        const list = [...computeBudgetPrefix(cu), ...ixs];
        const r = await deps.simulate(list);
        if (healedListUsable(r.err, list, params.programId, list.length - params.instructions.length)) {
          return { instructions: ixs, computeUnits: cu, repairs, outcome: "repaired", staleRefreshes: refreshIxs.length };
        }
      }
      if (repairs.length === 0 && cranks === 0) return unchanged("repair-did-not-help", { catchUpBeyondCap: beyondCap });
    }

    const crankIxs = cranks > 0 && params.catchUp && crankPortfolio
      ? Array.from({ length: cranks }, () =>
          buildCatchUpCrankIx(params.programId, params.catchUp!.cranker, params.market, crankPortfolio!, params.catchUp!.oracleTail ?? []),
        )
      : [];
    const repairIxs = repairs.map((r) => buildLivenessRepairIx(params.programId, params.market, r));
    const healedCu = Math.min(MAX_TX_CU, params.computeUnits + REPAIR_CU * repairs.length + CATCH_UP_CRANK_CU * crankIxs.length);
    const healedIxs = [...crankIxs, ...repairIxs, ...params.instructions];
    const healedList = [...computeBudgetPrefix(healedCu), ...healedIxs];
    const healed = await deps.simulate(healedList);
    if (healed.err && isRepairableFailure(healed.err, healedList, params.programId)) {
      return unchanged("repair-did-not-help", { catchUpBeyondCap: beyondCap });
    }
    return { instructions: healedIxs, computeUnits: healedCu, repairs, outcome: "repaired", catchUpCranks: crankIxs.length };
  } catch (e) {
    console.warn("[self-heal] skipped:", e);
    return unchanged("rpc-error");
  }
}

/** Placeholder blockhash for sim with replaceRecentBlockhash (any valid 32-byte base58). */
const SIM_BLOCKHASH = PublicKey.default.toBase58();

/** Real-connection deps for `planSelfHeal`. */
export function connectionSelfHealDeps(connection: Connection, market: PublicKey, payer: PublicKey): SelfHealDeps {
  return {
    readMarket: async () => {
      const res = await connection.getAccountInfoAndContext(market, "confirmed");
      if (!res.value) return null;
      return { data: new Uint8Array(res.value.data), slot: BigInt(res.context.slot) };
    },
    simulate: async (instructions) => {
      const tx = new Transaction();
      for (const ix of instructions) tx.add(ix);
      tx.feePayer = payer;
      tx.recentBlockhash = SIM_BLOCKHASH;
      const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: "confirmed",
      });
      return { err: sim.value.err };
    },
    findStaleRefreshes: (programId, cohort) => findStalePortfolios(connection, programId, market, cohort),
  };
}

/** Kill switch: NEXT_PUBLIC_SELF_HEAL=0 disables client self-heal. Default on. */
export function isSelfHealEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_SELF_HEAL?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
