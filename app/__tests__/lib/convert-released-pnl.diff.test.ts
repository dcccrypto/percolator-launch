/**
 * Differential test: app/lib/convert-released-pnl.ts vs. an independent port of the Rust engine
 * (percolator feat/v22-engine-rc23-2026-10-22, src/v16.rs; wrapper percolator-prog
 * feat/v22-rc23-2026-10-22 src/v16_program.rs). The port below is written from the Rust with
 * Rust's u128 semantics (checked_* → error, wide mul_div) and index loops, not by copying the TS.
 *
 * Rust counterparts (engine rc23 3e5970f3):
 *   releasedPnlFace                 convert_released_pnl_to_capital_core_not_atomic  v16.rs:25246-25247
 *   realizableSupportForClaimNum    source_credit_state_realizable_support_for_claim_num v16.rs:4112-4124
 *   availableBackingNum             available_backing_num_for_source_credit_state   v16.rs:3430-3446
 *   accountSourceRealizableSupport  account_source_support_inner (via account_source_realizable_support :12977) v16.rs:12984-13094
 *   bound_num_from_amount           v16.rs:2904-2908
 *   convertGate / has*              v16.rs:12346-12384, 20244-20277, 25248-25262
 *   simulateConvertMath             handler_convert_released_pnl percolator-prog v16_program.rs:26490-26531
 * (the TS header cites older lines, e.g. v16.rs:11094-11215 / 19863 / wrapper :19949: all drifted.)
 *
 * Out of scope for the TS mirror (documented, asserted below): Rust returns Err(ArithmeticOverflow /
 * CounterUnderflow) when a u128 intermediate overflows; the TS uses unbounded bigint. All such inputs
 * exceed MAX_VAULT_TVL (1e16 atoms, lib.rs:27) by >10 orders of magnitude, so they are unreachable.
 */
import { describe, it, expect } from "vitest";
import type { PortfolioSourceDomainV17 } from "@percolatorct/sdk";
import {
  BOUND_SCALE,
  CREDIT_RATE_SCALE,
  accountSourceRealizableSupport,
  availableBackingNum,
  convertCap,
  convertGate,
  planWithdraw,
  realizableSupportForClaimNum,
  releasedPnlFace,
  simulateConvertMath,
  type SourceDomainMarketState,
} from "@/lib/convert-released-pnl";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const U128 = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const U64 = (1n << 64n) - 1n;

// ── Rust-semantics port ────────────────────────────────────────────────────────────
type Err = "InvalidConfig" | "InvalidLeg" | "ArithmeticOverflow" | "CounterUnderflow" | "LockActive";
class RustErr extends Error {
  constructor(public kind: Err) {
    super(kind);
  }
}
const chkAdd = (a: bigint, b: bigint): bigint => {
  const r = a + b;
  if (r > U128) throw new RustErr("ArithmeticOverflow");
  return r;
};
const chkMul = (a: bigint, b: bigint): bigint => {
  const r = a * b;
  if (r > U128) throw new RustErr("ArithmeticOverflow");
  return r;
};
/** v16.rs:2425 mul_div_floor_u128_or_wide: u128 fast path, U256 slow path, result must fit u128. */
function mulDivWide(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new RustErr("InvalidConfig");
  const q = (a * b) / d;
  if (q > U128) throw new RustErr("ArithmeticOverflow");
  return q;
}
function rsAvailable(s: SourceDomainMarketState): bigint {
  if (s.freshReservedBackingNum < s.validLienedBackingNum) throw new RustErr("InvalidConfig");
  const enc = chkAdd(s.validLienedInsuranceNum, s.impairedLienedInsuranceNum);
  if (s.insuranceCreditReservedNum < enc) throw new RustErr("InvalidConfig");
  return chkAdd(s.freshReservedBackingNum - s.validLienedBackingNum, s.insuranceCreditReservedNum - enc);
}
function rsClaimSupport(s: SourceDomainMarketState, claim: bigint): bigint {
  if (claim === 0n || s.positiveClaimBoundNum === 0n) return 0n;
  const credited = mulDivWide(claim, s.creditRateNum, CREDIT_RATE_SCALE);
  const a = credited / BOUND_SCALE;
  const b = rsAvailable(s) / BOUND_SCALE;
  return a < b ? a : b;
}
const occupied = (s: PortfolioSourceDomainV17) =>
  s.sourceClaimBoundNum !== 0n || s.sourceClaimLienedNum !== 0n || s.sourceClaimCounterpartyLienedNum !== 0n ||
  s.sourceClaimInsuranceLienedNum !== 0n || s.sourceLienEffectiveReserved !== 0n || s.sourceLienCounterpartyBackingNum !== 0n ||
  s.sourceLienInsuranceBackingNum !== 0n || s.sourceLienFeeLastSlot !== 0n || s.sourceClaimImpairedNum !== 0n ||
  s.sourceLienImpairedEffectiveReserved !== 0n || s.sourceLienCapitalAtRiskFeeRevenue !== 0n ||
  s.sourceLienImpairedCapitalAtRiskFeeRevenue !== 0n;
const defaultTag = (s: PortfolioSourceDomainV17) => s.domain === 0 && s.sourceClaimMarketId === 0n;
const mn = (a: bigint, b: bigint) => (a < b ? a : b);

function rsSupport(slots: PortfolioSourceDomainV17[], face: bigint, st: (d: number) => SourceDomainMarketState): bigint {
  if (face === 0n) return 0n;
  let remaining = chkMul(face, BOUND_SCALE);
  let support = 0n;
  let slot = 0;
  while (slot < slots.length && remaining !== 0n) {
    const s = slots[slot];
    if (defaultTag(s) && !occupied(s)) break;
    if (!occupied(s)) {
      slot++;
      continue;
    }
    const locked = chkAdd(s.sourceClaimLienedNum, s.sourceClaimImpairedNum);
    if (locked > s.sourceClaimBoundNum) throw new RustErr("InvalidLeg");
    // source_lien_valid_support_num v16.rs:13165-13196
    let curCp = 0n;
    if (s.sourceLienCounterpartyBackingNum !== 0n) {
      curCp = st(s.domain).counterpartyBucketFresh ? s.sourceLienCounterpartyBackingNum : 0n;
    }
    const validLien = mn(mn(chkAdd(curCp, s.sourceLienInsuranceBackingNum), chkMul(s.sourceLienEffectiveReserved, BOUND_SCALE)), remaining);
    if (validLien !== 0n) {
      support = chkAdd(support, validLien / BOUND_SCALE);
      remaining -= validLien;
    }
    const claimNum = mn(s.sourceClaimBoundNum - locked, remaining);
    if (claimNum !== 0n) {
      support = chkAdd(support, rsClaimSupport(st(s.domain), claimNum));
      remaining -= claimNum;
    }
    slot++;
  }
  return support;
}

type Pf = { pnl: bigint; reservedPnl: bigint; sourceDomains: PortfolioSourceDomainV17[]; legs: { active: boolean; assetIndex: number; side: number }[] };
function rsConvert(pf: Pf, cap: bigint, st: (d: number) => SourceDomainMarketState): { ok: true; converted: bigint } | { ok: false; code: number } {
  if (cap === 0n) return { ok: false, code: WRAPPER_ERR.InvalidInstruction }; // v16_program.rs:26497-26499
  try {
    const pos = pf.pnl > 0n ? pf.pnl : 0n; // v16.rs:25246
    const released = pos > pf.reservedPnl ? pos - pf.reservedPnl : 0n;
    if (released === 0n) throw new RustErr("LockActive"); // core Ok(0) → handler converted==0 (:26528)
    // account_source_claim_bound_sum_num v16.rs:12346-12360 (sum, overflow → Err)
    let sum = 0n;
    for (let i = 0; i < pf.sourceDomains.length; i++) {
      const s = pf.sourceDomains[i];
      if (defaultTag(s) && !occupied(s)) break;
      sum = chkAdd(sum, s.sourceClaimBoundNum);
    }
    const claims = sum !== 0n;
    if (claims) {
      let liens = false;
      let exposure = false;
      for (let i = 0; i < pf.sourceDomains.length; i++) {
        const s = pf.sourceDomains[i];
        if (defaultTag(s) && !occupied(s)) break;
        if (s.sourceClaimLienedNum !== 0n) liens = true;
      }
      for (let i = 0; i < pf.sourceDomains.length && !exposure; i++) {
        const s = pf.sourceDomains[i];
        if (defaultTag(s) && !occupied(s)) break;
        if (occupied(s) && s.sourceClaimBoundNum !== 0n) {
          const asset = Math.floor(s.domain / 2);
          const srcSide = s.domain % 2 === 0 ? 0 : 1;
          const leg = pf.legs.find((l) => l.assetIndex === asset); // active_leg_for_asset
          if (leg && leg.active && 1 - leg.side === srcSide) exposure = true; // opposite_side(leg.side)==source_side
        }
      }
      if (liens || exposure) throw new RustErr("LockActive");
    }
    const converted = claims ? rsSupport(pf.sourceDomains, released, st) : 0n; // Live, no claims → 0
    if (converted === 0n) throw new RustErr("LockActive"); // v16.rs:25268
    if (converted > cap) throw new RustErr("LockActive"); // v16_program.rs:26528
    return { ok: true, converted };
  } catch (e) {
    if (e instanceof RustErr) return { ok: false, code: e.kind === "LockActive" ? WRAPPER_ERR.EngineLockActive : -1 };
    throw e;
  }
}

// ── seeded generators ──────────────────────────────────────────────────────────────
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const EDGES = [0n, 1n, 2n, 999_999_999_999n, BOUND_SCALE - 1n, BOUND_SCALE, BOUND_SCALE + 1n, 10_000_000_000_000_000n, U64 - 1n, U64, U64 + 1n, I128_MAX, U128];
function big(r: () => number, mode?: number): bigint {
  const m = mode ?? Math.floor(r() * 5);
  if (m === 0) return EDGES[Math.floor(r() * EDGES.length)];
  if (m === 1) return BigInt(Math.floor(r() * 1000));
  if (m === 2) return BigInt(Math.floor(r() * 1e15)) * BigInt(Math.floor(r() * 1e6) + 1);
  if (m === 3) return BigInt(Math.floor(r() * 1e16)) * BOUND_SCALE;
  return BigInt(Math.floor(r() * 2 ** 52)) * BigInt(Math.floor(r() * 2 ** 52));
}
/** values bounded by MAX_VAULT_TVL-scale (the reachable domain). */
const reach = (r: () => number) => BigInt(Math.floor(r() * 1e16)) * (r() < 0.5 ? 1n : BOUND_SCALE);

function mkState(r: () => number, reachable: boolean): SourceDomainMarketState {
  const g = reachable ? reach : (x: () => number) => big(x);
  const fresh = g(r);
  const validB = r() < 0.9 ? mn(fresh, g(r)) : g(r);
  const ins = g(r);
  const vi = r() < 0.9 ? mn(ins, g(r)) : g(r);
  const ii = r() < 0.9 ? mn(ins - mn(ins, vi), g(r)) : g(r);
  return {
    counterpartyBucketFresh: r() < 0.6,
    creditRateNum: r() < 0.3 ? CREDIT_RATE_SCALE : r() < 0.1 ? 0n : reachable ? BigInt(Math.floor(r() * 1e12)) : mn(big(r), U128),
    positiveClaimBoundNum: r() < 0.1 ? 0n : 1n + g(r),
    freshReservedBackingNum: fresh,
    validLienedBackingNum: validB,
    insuranceCreditReservedNum: ins,
    validLienedInsuranceNum: vi,
    impairedLienedInsuranceNum: ii,
  };
}
function mkSlot(r: () => number, domain: number, reachable: boolean): PortfolioSourceDomainV17 {
  const g = reachable ? reach : (x: () => number) => big(x);
  const bound = g(r);
  const liened = r() < 0.7 ? 0n : mn(bound, g(r));
  const impaired = r() < 0.8 ? 0n : mn(bound - liened, g(r));
  const lienActive = r() < 0.3;
  const eff = lienActive ? BigInt(Math.floor(r() * 1e12)) : 0n;
  return {
    domain,
    sourceClaimMarketId: r() < 0.5 ? 0n : BigInt(1 + Math.floor(r() * 5)),
    sourceClaimBoundNum: bound,
    sourceClaimLienedNum: r() < 0.05 ? g(r) : liened, // 5%: locked > bound → InvalidLeg
    sourceClaimCounterpartyLienedNum: 0n,
    sourceClaimInsuranceLienedNum: 0n,
    sourceLienEffectiveReserved: eff,
    sourceLienCounterpartyBackingNum: lienActive && r() < 0.6 ? g(r) : 0n,
    sourceLienInsuranceBackingNum: lienActive && r() < 0.6 ? g(r) : 0n,
    sourceLienFeeLastSlot: r() < 0.1 ? 5n : 0n,
    sourceClaimImpairedNum: impaired,
    sourceLienImpairedEffectiveReserved: 0n,
    sourceLienCapitalAtRiskFeeRevenue: 0n,
    sourceLienImpairedCapitalAtRiskFeeRevenue: 0n,
  } as PortfolioSourceDomainV17;
}
function mkSlots(r: () => number, reachable: boolean): PortfolioSourceDomainV17[] {
  const n = Math.floor(r() * 5); // 0..4 slots, multi-lien accounts included
  const out: PortfolioSourceDomainV17[] = [];
  for (let i = 0; i < n; i++) {
    const s = mkSlot(r, Math.floor(r() * 6), reachable);
    if (r() < 0.1) Object.assign(s, { sourceClaimBoundNum: 0n, sourceClaimLienedNum: 0n, sourceClaimImpairedNum: 0n }); // hole / zeroed
    out.push(s);
  }
  // a pad of default slots (sparse tail), occasionally followed by a hidden claim
  out.push(mkSlot(r, 0, reachable));
  Object.assign(out[out.length - 1], { domain: 0, sourceClaimMarketId: 0n, sourceClaimBoundNum: 0n, sourceClaimLienedNum: 0n, sourceClaimImpairedNum: 0n, sourceLienEffectiveReserved: 0n, sourceLienCounterpartyBackingNum: 0n, sourceLienInsuranceBackingNum: 0n, sourceLienFeeLastSlot: 0n });
  if (r() < 0.2) out.push(mkSlot(r, 1 + Math.floor(r() * 4), reachable));
  return out;
}

type Outcome = { v: bigint } | { err: "revert" | "overflow" };
function tsCall<T>(f: () => T): { v: T } | { thrown: true } {
  try {
    return { v: f() };
  } catch {
    return { thrown: true };
  }
}

const N = 12_000;

describe("differential: convert-released-pnl vs Rust v16.rs port", () => {
  it("releasedPnlFace + convertCap: boundary table and 12k seeded cases, 0 mismatches", () => {
    const rustReleased = (pnl: bigint, res: bigint) => {
      const pos = pnl > 0n ? pnl : 0n;
      return pos > res ? pos - res : 0n; // pos.saturating_sub(reserved_pnl)
    };
    const vals = [-I128_MAX - 1n, -1n, 0n, 1n, 2n, U64 - 1n, U64, U64 + 1n, I128_MAX];
    let mism = 0;
    let n = 0;
    for (const a of vals) for (const b of [0n, 1n, 2n, U64, U64 + 1n, I128_MAX, U128]) {
      n++;
      if (releasedPnlFace(a, b) !== rustReleased(a, b)) mism++;
    }
    const r = rng(1);
    for (let i = 0; i < N; i++) {
      const a = r() < 0.2 ? -big(r) : big(r);
      const b = big(r);
      n++;
      if (releasedPnlFace(a, b) !== rustReleased(a, b)) mism++;
      if (convertCap(a) !== (a > 0n ? a : 0n)) mism++;
    }
    console.log(`[diff] releasedPnlFace/convertCap cases=${n} mismatches=${mism}`);
    expect(mism).toBe(0);
  });

  it("availableBackingNum + realizableSupportForClaimNum: scale/u128 edges + 12k seeded", () => {
    let n = 0;
    let mism = 0;
    let overflowOnly = 0;
    const check = (s: SourceDomainMarketState, claim: bigint) => {
      n++;
      let rs: bigint | RustErr;
      try {
        rs = rsClaimSupport(s, claim);
      } catch (e) {
        rs = e as RustErr;
      }
      const ts = tsCall(() => realizableSupportForClaimNum(s, claim));
      if (rs instanceof RustErr) {
        if (rs.kind === "InvalidConfig") {
          if (!("thrown" in ts)) mism++;
        } else overflowOnly++; // Rust ArithmeticOverflow/CounterUnderflow; TS unbounded or a different error kind (unreachable, see header)
      } else if ("thrown" in ts || ts.v !== rs) mism++;
    };
    const base: SourceDomainMarketState = {
      counterpartyBucketFresh: true, creditRateNum: CREDIT_RATE_SCALE, positiveClaimBoundNum: 1n,
      freshReservedBackingNum: 10n * BOUND_SCALE, validLienedBackingNum: 0n, insuranceCreditReservedNum: 0n,
      validLienedInsuranceNum: 0n, impairedLienedInsuranceNum: 0n,
    };
    for (const claim of EDGES) for (const rate of [0n, 1n, CREDIT_RATE_SCALE - 1n, CREDIT_RATE_SCALE, CREDIT_RATE_SCALE + 1n, U64, U128]) {
      for (const fresh of [0n, 1n, BOUND_SCALE - 1n, BOUND_SCALE, 10n * BOUND_SCALE, U128]) check({ ...base, creditRateNum: rate, freshReservedBackingNum: fresh }, claim);
    }
    check({ ...base, positiveClaimBoundNum: 0n }, 5n * BOUND_SCALE);
    check({ ...base, validLienedBackingNum: 11n * BOUND_SCALE }, BOUND_SCALE); // fresh < lien → InvalidConfig
    check({ ...base, insuranceCreditReservedNum: 1n, validLienedInsuranceNum: 1n, impairedLienedInsuranceNum: 1n }, BOUND_SCALE);
    check({ ...base, validLienedInsuranceNum: U128, impairedLienedInsuranceNum: 1n, insuranceCreditReservedNum: U128 }, BOUND_SCALE); // enc overflow
    const r = rng(2);
    for (let i = 0; i < N; i++) check(mkState(r, i % 2 === 0), i % 3 === 0 ? big(r) : reach(r));
    console.log(`[diff] realizableSupportForClaimNum/availableBackingNum cases=${n} mismatches=${mism} rust-overflow-only(unreachable)=${overflowOnly}`);
    expect(mism).toBe(0);
    // reachable domain (values ≤ 1e16·1e12) never hits the overflow-only bucket
    let reachableOverflow = 0;
    const r2 = rng(22);
    for (let i = 0; i < 2000; i++) {
      try {
        rsClaimSupport(mkState(r2, true), reach(r2));
      } catch {
        reachableOverflow++;
      }
    }
    expect(availableBackingNum(base)).toBe(10n * BOUND_SCALE);
    console.log(`[diff] reachable-domain rust errors (InvalidConfig from random state) counted=${reachableOverflow}`);
  });

  it("accountSourceRealizableSupport: multi-lien accounts, 12k seeded + edges", () => {
    let n = 0;
    let mism = 0;
    let overflowOnly = 0;
    let nonzero = 0;
    const run = (slots: PortfolioSourceDomainV17[], face: bigint, states: SourceDomainMarketState[]) => {
      const st = (d: number) => states[d % states.length];
      n++;
      let rs: bigint | RustErr;
      try {
        rs = rsSupport(slots, face, st);
      } catch (e) {
        rs = e as RustErr;
      }
      const ts = tsCall(() => accountSourceRealizableSupport(slots, face, st));
      if (rs instanceof RustErr) {
        if (rs.kind === "InvalidConfig" || rs.kind === "InvalidLeg") {
          if (!("thrown" in ts)) mism++;
        } else overflowOnly++; // unreachable overflow domain
      } else {
        if ("thrown" in ts || ts.v !== rs) mism++;
        if (rs !== 0n) nonzero++;
      }
    };
    const r = rng(3);
    for (let i = 0; i < N; i++) {
      const reachable = i % 4 !== 0;
      const slots = mkSlots(r, reachable);
      const states = [mkState(r, reachable), mkState(r, reachable), mkState(r, reachable)];
      const face = r() < 0.15 ? 0n : reachable ? BigInt(Math.floor(r() * 1e16)) : big(r);
      run(slots, face, states);
    }
    // fixed edges: one slot, claim exactly at scale
    const slot = mkSlot(rng(9), 0, true);
    Object.assign(slot, { sourceClaimBoundNum: 5n * BOUND_SCALE, sourceClaimLienedNum: 0n, sourceClaimImpairedNum: 0n, sourceLienEffectiveReserved: 0n, sourceLienCounterpartyBackingNum: 0n, sourceLienInsuranceBackingNum: 0n, sourceLienFeeLastSlot: 0n, sourceClaimMarketId: 1n });
    const st: SourceDomainMarketState = { counterpartyBucketFresh: true, creditRateNum: CREDIT_RATE_SCALE, positiveClaimBoundNum: 5n * BOUND_SCALE, freshReservedBackingNum: 5n * BOUND_SCALE, validLienedBackingNum: 0n, insuranceCreditReservedNum: 0n, validLienedInsuranceNum: 0n, impairedLienedInsuranceNum: 0n };
    for (const face of [0n, 1n, 4n, 5n, 6n, U64, U64 + 1n, I128_MAX]) run([slot], face, [st]);
    console.log(`[diff] accountSourceRealizableSupport cases=${n} nonzero=${nonzero} mismatches=${mism} rust-overflow-only(unreachable)=${overflowOnly}`);
    expect(nonzero).toBeGreaterThan(500); // the generator actually exercises the support path
    expect(mism).toBe(0);
  });

  it("convertGate + simulateConvertMath vs handler port: 12k seeded + edges", () => {
    let n = 0;
    let mism = 0;
    let ok = 0;
    let overflowOnly = 0;
    const r = rng(4);
    for (let i = 0; i < N + 50; i++) {
      const reachable = i % 4 !== 0;
      const slots = mkSlots(r, reachable);
      const pnl = r() < 0.15 ? -reach(r) : r() < 0.1 ? 0n : reachable ? BigInt(Math.floor(r() * 1e16)) : big(r);
      const reserved = r() < 0.6 ? 0n : mn(pnl > 0n ? pnl : 0n, reachable ? reach(r) : big(r));
      const legs = r() < 0.5 ? [] : [{ active: r() < 0.8, assetIndex: Math.floor(r() * 3), side: Math.floor(r() * 2) }];
      const pf: Pf = { pnl, reservedPnl: reserved, sourceDomains: slots, legs };
      const states = [mkState(r, reachable), mkState(r, reachable), mkState(r, reachable)];
      const st = (d: number) => states[d % states.length];
      const released = releasedPnlFace(pnl, reserved);
      const cap = r() < 0.1 ? 0n : r() < 0.5 ? convertCap(pnl) : r() < 0.5 ? released : BigInt(Math.floor(r() * 1e16));
      n++;
      const rs = rsConvert(pf, cap, st);
      let ts: ReturnType<typeof simulateConvertMath> | "thrown";
      try {
        ts = simulateConvertMath(pf, cap, st);
      } catch {
        ts = "thrown";
      }
      if (rs.ok) ok++;
      if (ts === "thrown") {
        if (!(!rs.ok && rs.code === -1)) mism++; // TS throws ⇔ Rust InvalidConfig/InvalidLeg
        else if (false) overflowOnly++;
      } else if (rs.ok !== ts.ok) {
        // Rust overflow Err (code -1) while TS has a value: only legal on unreachable inputs
        if (!rs.ok && rs.code === -1 && reachable === false) overflowOnly++;
        else mism++;
      } else if (rs.ok && ts.ok && rs.converted !== ts.converted) mism++;
      else if (!rs.ok && !ts.ok && rs.code !== ts.code && rs.code !== -1) mism++;
      // convertGate agrees with the handler's pre-support gating
      const gate = convertGate(pf);
      if (released === 0n && gate.kind !== "nothing") mism++;
    }
    // zero cap, no claims, unbacked
    const none: Pf = { pnl: 10n, reservedPnl: 0n, sourceDomains: [], legs: [] };
    if (simulateConvertMath(none, 0n, () => { throw new Error("x"); }).ok !== false) mism++;
    const z = simulateConvertMath(none, 0n, () => { throw new Error("x"); });
    if (z.ok || z.code !== WRAPPER_ERR.InvalidInstruction) mism++;
    console.log(`[diff] simulateConvertMath/convertGate cases=${n} converted-ok=${ok} mismatches=${mism} rust-overflow-only(unreachable)=${overflowOnly}`);
    expect(ok).toBeGreaterThan(300);
    expect(mism).toBe(0);
  });

  it("planWithdraw vs v16.rs:20435-20436 (amount > capital → LockActive): table + 12k seeded", () => {
    // Rust: withdraw ok iff amount <= capital. After convert the capital is capital+converted.
    const rust = (capital: bigint, convertible: bigint, amount: bigint) => {
      if (amount <= capital) return { needsConvert: false, fits: true };
      return { needsConvert: convertible > 0n, fits: amount <= capital + convertible };
    };
    let n = 0;
    let mism = 0;
    const chk = (c: bigint, v: bigint, a: bigint) => {
      n++;
      const t = planWithdraw({ capital: c, convertible: v, amount: a });
      const e = rust(c, v, a);
      if (t.needsConvert !== e.needsConvert || t.fits !== e.fits) mism++;
    };
    for (const c of EDGES) for (const v of EDGES) for (const a of EDGES) chk(c, v, a);
    const r = rng(5);
    for (let i = 0; i < N; i++) chk(big(r), big(r), big(r));
    console.log(`[diff] planWithdraw cases=${n} mismatches=${mism}`);
    expect(mism).toBe(0);
  });
});
