/**
 * ConvertReleasedPnl (wrapper tag 28): move a flat trader's released, backed profit
 * from `portfolio.pnl` into `portfolio.capital`, so that Withdraw can pay it out.
 *
 * Why the app needs it: the engine's `withdraw_not_atomic` bounds a withdrawal by
 * CAPITAL ONLY — `amount > capital → LockActive` (engine 35ddd692 src/v16.rs:20435-20436).
 * Positive pnl reaches capital only through `convert_released_pnl_to_capital_not_atomic`
 * (v16.rs:20033), whose only Live trader caller is wrapper tag 28 (deployed wrapper
 * bd4fe5f8 src/v16_program.rs:19942-19977). Without tag 28 a winner's realized profit is
 * stuck in pnl and can never be withdrawn.
 *
 * ── Handler semantics (bd4fe5f8 src/v16_program.rs:19942-19977) ──────────────────────
 *   - `amount == 0` → InvalidInstruction (:19949-19951).
 *   - accounts via `with_one_portfolio_view(.., owner_must_sign = true, Some((portfolio_id,
 *     position_epoch)))` (:31795-31870): [0] owner signer, [1] market writable+owned,
 *     [2] portfolio writable+owned; binding mismatch → EngineProvenanceMismatch (16).
 *     SDK 8.0.0 `ACCOUNTS_CONVERT_RELEASED_PNL` is exactly this list.
 *   - mode != Live, or matured permissionless resolve → LockActive (:19957-19962).
 *   - The engine converts ALL currently released+supported pnl at once (:19972). `amount`
 *     is a CALLER CAP, not a request: `converted == 0 || converted > amount → LockActive`
 *     (:19973-19975). So the cap must be ≥ the full convertible amount; we pass the
 *     account's whole positive pnl face, which bounds `converted` (v16.rs:19863-19864).
 *
 * ── Engine math (35ddd692 src/v16.rs) ────────────────────────────────────────────────
 *   preflight (:19843-19856): Live, no payout snapshot, `ensure_favorable_action_allowed`
 *     (:16309-16326): h-lock lane != HMax, health certificate CURRENT (else Stale 19),
 *     no target-effective lag on an active leg.
 *   core (:19858-19890):
 *     pos = max(pnl, 0); released = pos − reserved_pnl            (:19863-19864)
 *     released == 0 → converts nothing                             (:19865-19867)
 *     has source claims AND (liens OR active opposite-side exposure on a source
 *       domain) → LockActive                                       (:19868-19873)
 *     converted = has source claims ? account_source_realizable_support(released)
 *               : Live ? 0 : haircut support                       (:19874-19880)
 *     converted == 0 → LockActive                                  (:19881-19883)
 *   account_source_realizable_support (:11094-11215) — see `accountSourceRealizableSupport`.
 *
 * The portfolio-side half of that math is mirrored below exactly (pure, unit-tested against
 * handler-derived vectors). The market-side half (each domain's credit rate, available
 * backing, bucket freshness, the vault-LP relabel the wrapper runs first at :19966-19971,
 * h-lock, certificate epochs) lives in market state the app does not decode, so the amount
 * shown to the user is read from a SIMULATION of tag 28 itself (`quoteConvertible`) — the
 * handler is the oracle; the mirror decides when simulating is pointless and why.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  ACCOUNTS_CONVERT_RELEASED_PNL,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  buildIx,
  encodeConvertReleasedPnl,
  encodePermissionlessCrank,
} from "@percolatorct/sdk";
import type { PortfolioLegV17, PortfolioSourceDomainV17, PortfolioV17 } from "@percolatorct/sdk";
import { defaultCrankObservations } from "@/lib/v18-wire";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { parseCustomInstructionError } from "@/lib/self-heal";
import { parsePortfolio } from "@/lib/v22/layout";

export const CONVERT_RELEASED_PNL_TAG = 28;
/** percolator src/lib.rs:25-26. */
export const BOUND_SCALE = 1_000_000_000_000n;
export const CREDIT_RATE_SCALE = 1_000_000_000_000n;
/** PORTFOLIO_SOURCE_DOMAIN_CAP — the SDK decodes this many slots. */
const SIDE_LONG = 0;

// ── Pure mirror of the engine (portfolio side) ──────────────────────────────────────

/** v16.rs:19863-19864: `pos = pnl.max(0); released = pos.saturating_sub(reserved_pnl)`. */
export function releasedPnlFace(pnl: bigint, reservedPnl: bigint): bigint {
  const pos = pnl > 0n ? pnl : 0n;
  return pos > reservedPnl ? pos - reservedPnl : 0n;
}

/** v16.rs:22352-22365 `is_occupied`. */
export function isSourceSlotOccupied(s: PortfolioSourceDomainV17): boolean {
  return (
    s.sourceClaimBoundNum !== 0n ||
    s.sourceClaimLienedNum !== 0n ||
    s.sourceClaimCounterpartyLienedNum !== 0n ||
    s.sourceClaimInsuranceLienedNum !== 0n ||
    s.sourceLienEffectiveReserved !== 0n ||
    s.sourceLienCounterpartyBackingNum !== 0n ||
    s.sourceLienInsuranceBackingNum !== 0n ||
    s.sourceLienFeeLastSlot !== 0n ||
    s.sourceClaimImpairedNum !== 0n ||
    s.sourceLienImpairedEffectiveReserved !== 0n ||
    s.sourceLienCapitalAtRiskFeeRevenue !== 0n ||
    s.sourceLienImpairedCapitalAtRiskFeeRevenue !== 0n
  );
}

/** v16.rs:22368-22370 `has_default_sparse_tag`. */
function hasDefaultSparseTag(s: PortfolioSourceDomainV17): boolean {
  return s.domain === 0 && s.sourceClaimMarketId === 0n;
}

/**
 * The engine's sparse source-domain walk: stop at the first default-tagged unoccupied slot,
 * skip other unoccupied slots (v16.rs:10471-10476, 10490-10495, 11103-11111).
 */
export function occupiedSourceSlots(slots: readonly PortfolioSourceDomainV17[]): PortfolioSourceDomainV17[] {
  const out: PortfolioSourceDomainV17[] = [];
  for (const s of slots) {
    if (hasDefaultSparseTag(s) && !isSourceSlotOccupied(s)) break;
    if (isSourceSlotOccupied(s)) out.push(s);
  }
  return out;
}

/** v16.rs:10483-10485 (sum of source_claim_bound_num != 0). */
export function hasSourceClaims(slots: readonly PortfolioSourceDomainV17[]): boolean {
  return occupiedSourceSlots(slots).some((s) => s.sourceClaimBoundNum !== 0n);
}

/** v16.rs:10489-10500: any slot with source_claim_liened_num != 0. */
export function hasSourceLiens(slots: readonly PortfolioSourceDomainV17[]): boolean {
  return occupiedSourceSlots(slots).some((s) => s.sourceClaimLienedNum !== 0n);
}

/**
 * v16.rs:16337-16359 + 16328-16335: a source domain d = (asset d/2, side d%2 [0=long])
 * (v16.rs:8897-8911) is exposed when the account's active leg on that asset is on the
 * OPPOSITE side.
 */
export function hasActiveSourceClaimExposure(
  slots: readonly PortfolioSourceDomainV17[],
  legs: readonly Pick<PortfolioLegV17, "active" | "assetIndex" | "side">[],
): boolean {
  return occupiedSourceSlots(slots).some((s) => {
    if (s.sourceClaimBoundNum === 0n) return false;
    const asset = Math.floor(s.domain / 2);
    const sourceSide = s.domain % 2 === 0 ? SIDE_LONG : 1;
    const leg = legs.find((l) => l.active && l.assetIndex === asset);
    return !!leg && leg.side !== sourceSide;
  });
}

/** Market-side inputs to `account_source_realizable_support` for one source domain. */
export interface SourceDomainMarketState {
  /** The domain's counterparty backing bucket is `Fresh` with expiry_slot > current_slot (v16.rs:11171-11178). */
  counterpartyBucketFresh: boolean;
  /** SourceCreditStateV16 fields (v16.rs:2593-2609, 3275-3286). */
  creditRateNum: bigint;
  positiveClaimBoundNum: bigint;
  freshReservedBackingNum: bigint;
  validLienedBackingNum: bigint;
  insuranceCreditReservedNum: bigint;
  validLienedInsuranceNum: bigint;
  impairedLienedInsuranceNum: bigint;
}

/** v16.rs:2593-2609 `available_backing_num_for_source_credit_state`. */
export function availableBackingNum(st: SourceDomainMarketState): bigint {
  if (st.freshReservedBackingNum < st.validLienedBackingNum) throw new Error("InvalidConfig");
  const insEnc = st.validLienedInsuranceNum + st.impairedLienedInsuranceNum;
  if (st.insuranceCreditReservedNum < insEnc) throw new Error("InvalidConfig");
  return st.freshReservedBackingNum - st.validLienedBackingNum + (st.insuranceCreditReservedNum - insEnc);
}

/** v16.rs:3275-3286 `source_credit_state_realizable_support_for_claim_num`. */
export function realizableSupportForClaimNum(st: SourceDomainMarketState, claimNum: bigint): bigint {
  if (claimNum === 0n || st.positiveClaimBoundNum === 0n) return 0n;
  const credited = (claimNum * st.creditRateNum) / CREDIT_RATE_SCALE;
  const a = credited / BOUND_SCALE;
  const b = availableBackingNum(st) / BOUND_SCALE;
  return a < b ? a : b;
}

const min = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));

/** v16.rs:11094-11215 `account_source_realizable_support`, verbatim. */
export function accountSourceRealizableSupport(
  slots: readonly PortfolioSourceDomainV17[],
  faceClaim: bigint,
  stateFor: (domain: number) => SourceDomainMarketState,
): bigint {
  if (faceClaim === 0n) return 0n;
  let remaining = faceClaim * BOUND_SCALE; // bound_num_from_amount (v16.rs:2108-2112)
  let support = 0n;
  for (const s of occupiedSourceSlots(slots)) {
    if (remaining === 0n) break;
    const locked = s.sourceClaimLienedNum + s.sourceClaimImpairedNum;
    if (locked > s.sourceClaimBoundNum) throw new Error("InvalidLeg");
    const cp = s.sourceLienCounterpartyBackingNum;
    const currentCp = cp === 0n ? 0n : stateFor(s.domain).counterpartyBucketFresh ? cp : 0n;
    const validLien = min(currentCp + s.sourceLienInsuranceBackingNum, s.sourceLienEffectiveReserved * BOUND_SCALE, remaining);
    if (validLien !== 0n) {
      support += validLien / BOUND_SCALE;
      remaining -= validLien;
    }
    const claimNum = min(s.sourceClaimBoundNum - locked, remaining);
    if (claimNum !== 0n) {
      support += realizableSupportForClaimNum(stateFor(s.domain), claimNum);
      remaining -= claimNum;
    }
  }
  return support;
}

export type ConvertGate =
  | { kind: "convertible"; released: bigint }
  /** Nothing to convert: pnl ≤ 0 or fully reserved (v16.rs:19865-19867). */
  | { kind: "nothing" }
  /** Live + no source claims → converts 0 → LockActive (v16.rs:19876-19883). */
  | { kind: "unbacked"; released: bigint }
  /** Liens, or an open position against the profit's source (v16.rs:19868-19873). */
  | { kind: "locked"; released: bigint };

/** The portfolio-only gates of `convert_released_pnl_to_capital_core_not_atomic` (Live mode). */
export function convertGate(pf: Pick<PortfolioV17, "pnl" | "reservedPnl" | "sourceDomains" | "legs">): ConvertGate {
  const released = releasedPnlFace(pf.pnl, pf.reservedPnl);
  if (released === 0n) return { kind: "nothing" };
  const claims = hasSourceClaims(pf.sourceDomains);
  if (claims && (hasSourceLiens(pf.sourceDomains) || hasActiveSourceClaimExposure(pf.sourceDomains, pf.legs))) {
    return { kind: "locked", released };
  }
  if (!claims) return { kind: "unbacked", released };
  return { kind: "convertible", released };
}

/**
 * Full mirror (Live): what tag 28 with `cap` converts, or the error code it raises.
 * Given the market-side domain state this reproduces the handler's outcome.
 */
export function simulateConvertMath(
  pf: Pick<PortfolioV17, "pnl" | "reservedPnl" | "sourceDomains" | "legs">,
  cap: bigint,
  stateFor: (domain: number) => SourceDomainMarketState,
): { ok: true; converted: bigint } | { ok: false; code: number } {
  if (cap === 0n) return { ok: false, code: WRAPPER_ERR.InvalidInstruction }; // :19949-19951
  const gate = convertGate(pf);
  // released == 0 → core returns Ok(0) → handler `converted == 0` → LockActive (:19973).
  if (gate.kind !== "convertible") return { ok: false, code: WRAPPER_ERR.EngineLockActive };
  const converted = accountSourceRealizableSupport(pf.sourceDomains, gate.released, stateFor);
  if (converted === 0n || converted > cap) return { ok: false, code: WRAPPER_ERR.EngineLockActive };
  return { ok: true, converted };
}

/** The cap we sign: the whole positive pnl face, which bounds `converted` (v16.rs:19863-19864). */
export function convertCap(pnl: bigint): bigint {
  return pnl > 0n ? pnl : 0n;
}

/**
 * v16.rs:20435-20436: withdraw needs `amount ≤ capital`. Returns whether tag 28 must run
 * first and whether the request fits at all.
 */
export function planWithdraw(p: { capital: bigint; convertible: bigint; amount: bigint }): {
  needsConvert: boolean;
  fits: boolean;
} {
  if (p.amount <= p.capital) return { needsConvert: false, fits: true };
  return { needsConvert: p.convertible > 0n, fits: p.amount <= p.capital + p.convertible };
}

// ── Instructions ────────────────────────────────────────────────────────────────────

export interface ConvertIxParams {
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  portfolioId: bigint;
  positionEpoch: bigint;
  cap: bigint;
}

/** Tag 28: [owner(s), market(w), portfolio(w)] + tag‖portfolio_id u64‖position_epoch u64‖amount u128. */
export function buildConvertReleasedPnlIx(p: ConvertIxParams): TransactionInstruction {
  return buildIx({
    programId: p.programId,
    keys: buildAccountMetas(ACCOUNTS_CONVERT_RELEASED_PNL, [p.owner, p.market, p.portfolio]),
    data: encodeConvertReleasedPnl({ portfolioId: p.portfolioId, positionEpoch: p.positionEpoch, amount: p.cap }),
  });
}

/**
 * Refreshes the portfolio's health certificate. Right after a close the certificate is behind
 * the market epochs, and tag 28's `ensure_favorable_action_current_certificate`
 * (v16.rs:16309-16326) refuses with Stale(19) — measured on devnet for a freshly closed winner.
 * A PermissionlessCrank on the user's own portfolio re-certifies it inside the same tx.
 */
export function buildRecertifyCrankIx(programId: PublicKey, owner: PublicKey, market: PublicKey, portfolio: PublicKey): TransactionInstruction {
  return buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [owner, market, portfolio]),
    data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
  });
}

// ── Live quote (the handler is the oracle) ─────────────────────────────────────────

export type ConvertQuote =
  | { status: "none" }
  | {
      status: "ready";
      /** Capital after the prefix runs — the most a withdraw in the same tx can take. */
      postCapital: bigint;
      /** postCapital − capital now: the profit the prefix makes withdrawable. */
      convertible: bigint;
      /** Instructions to put in front of the withdraw: [recertify crank?] + [tag 28]. */
      prefix: TransactionInstruction[];
    }
  | { status: "settling"; released: bigint; code: number | null };

export interface QuoteDeps {
  simulate: (
    ixs: TransactionInstruction[],
    readBack: PublicKey,
  ) => Promise<{ err: unknown; postData: Uint8Array | null; rpcFailed: boolean }>;
}

export interface QuoteParams {
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  portfolio: PublicKey;
  /** Live portfolio bytes (owner already verified by the caller). */
  portfolioData: Uint8Array;
}

/**
 * How much released profit tag 28 would move into capital right now, and the instructions
 * that do it. Tries tag 28 alone, then with the recertify crank in front on Stale(19).
 */
export async function quoteConvertible(p: QuoteParams, deps: QuoteDeps): Promise<ConvertQuote> {
  const pf = parsePortfolio(p.portfolioData);
  if (pf.legs.some((l) => l.active)) return { status: "none" }; // withdraw is flat-only (v16.rs:20416-20418)
  const gate = convertGate(pf);
  if (gate.kind === "nothing") return { status: "none" };
  if (gate.kind !== "convertible") return { status: "settling", released: gate.released, code: WRAPPER_ERR.EngineLockActive };
  const convert = buildConvertReleasedPnlIx({
    programId: p.programId,
    owner: p.owner,
    market: p.market,
    portfolio: p.portfolio,
    portfolioId: pf.portfolioId,
    positionEpoch: pf.matcherPositionEpoch,
    cap: convertCap(pf.pnl),
  });
  const plans: TransactionInstruction[][] = [
    [convert],
    [buildRecertifyCrankIx(p.programId, p.owner, p.market, p.portfolio), convert],
  ];
  let lastCode: number | null = null;
  for (const prefix of plans) {
    const r = await deps.simulate(prefix, p.portfolio);
    if (r.rpcFailed) return { status: "settling", released: gate.released, code: null };
    if (!r.err && r.postData) {
      const post = parsePortfolio(r.postData);
      // Read the program's own result: what tag 28 moved (and anything the recertify
      // crank settled) is exactly post.capital − capital.
      const convertible = post.capital - pf.capital;
      if (post.capital > pf.capital) return { status: "ready", postCapital: post.capital, convertible, prefix };
      return { status: "settling", released: gate.released, code: null };
    }
    const c = parseCustomInstructionError(r.err);
    lastCode = c && prefix[c.index]?.programId.equals(p.programId) ? c.code : null;
    if (lastCode !== WRAPPER_ERR.EngineStale) break; // only a stale certificate is worth the crank
  }
  return { status: "settling", released: gate.released, code: lastCode };
}

/** A withdraw the client refuses before signing; the message is user-facing as-is. */
export class WithdrawRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WithdrawRefusal";
  }
}

export const WITHDRAW_EXCEEDS_BALANCE_MESSAGE =
  "Withdrawal amount exceeds your account balance. Reduce the amount and try again.";

/**
 * The instructions useWithdraw puts in front of a flat account's Withdraw(amount): none when
 * the amount fits in capital; [recertify crank?, tag 28] when the excess is released, backed
 * profit; a WithdrawRefusal (calm copy) when the profit is not withdrawable yet or the amount
 * exceeds capital + convertible profit.
 */
export async function convertPrefixForWithdraw(
  p: QuoteParams & { amount: bigint },
  deps: QuoteDeps,
): Promise<TransactionInstruction[]> {
  const pf = parsePortfolio(p.portfolioData);
  if (p.amount <= pf.capital || pf.legs.some((l) => l.active)) return [];
  if (pf.pnl <= 0n) throw new WithdrawRefusal(WITHDRAW_EXCEEDS_BALANCE_MESSAGE);
  const quote = await quoteConvertible(p, deps);
  if (quote.status === "settling") throw new WithdrawRefusal(settlingProfitMessage(quote.code));
  const convertible = quote.status === "ready" ? quote.postCapital - pf.capital : 0n;
  const plan = planWithdraw({ capital: pf.capital, convertible, amount: p.amount });
  if (!plan.fits) throw new WithdrawRefusal(WITHDRAW_EXCEEDS_BALANCE_MESSAGE);
  return plan.needsConvert && quote.status === "ready" ? quote.prefix : [];
}

/** QuoteDeps over a real connection: one simulateTransaction with the portfolio read back. */
export function connectionQuoteDeps(connection: Connection, feePayer: PublicKey): QuoteDeps {
  return {
    async simulate(ixs, readBack) {
      try {
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
        for (const ix of ixs) tx.add(ix);
        tx.feePayer = feePayer;
        tx.recentBlockhash = "11111111111111111111111111111111"; // replaced by the RPC
        const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
          replaceRecentBlockhash: true,
          sigVerify: false,
          commitment: "confirmed",
          accounts: { encoding: "base64", addresses: [readBack.toBase58()] },
        });
        // Shift the instruction index past the compute-budget ix so callers see `ixs` indices.
        const err = shiftInstructionIndex(sim.value.err, -1);
        const acc = sim.value.accounts?.[0];
        const postData = acc ? new Uint8Array(Buffer.from(acc.data[0], "base64")) : null;
        return { err, postData, rpcFailed: false };
      } catch {
        return { err: null, postData: null, rpcFailed: true };
      }
    },
  };
}

function shiftInstructionIndex(err: unknown, by: number): unknown {
  if (!err || typeof err !== "object") return err ?? null;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || typeof ie[0] !== "number") return err;
  return { InstructionError: [ie[0] + by, ie[1]] };
}

// ── Copy ───────────────────────────────────────────────────────────────────────────

/** One calm line for profit that is not withdrawable yet (Custom 21 / 19 / 16 on tag 28). */
export function settlingProfitMessage(code: number | null): string {
  if (code === WRAPPER_ERR.EngineStale || code === WRAPPER_ERR.EngineProvenanceMismatch) {
    return "Your profit is being updated with the latest prices and will be withdrawable in a moment.";
  }
  return "Your profit becomes withdrawable once the other side of your trade settles, which happens automatically; your deposit can be withdrawn now.";
}
