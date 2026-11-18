// @vitest-environment node
/**
 * Seeded reference table: earn-split-pot.ts vs a line-by-line BigInt transcription of
 * percolator-prog origin/feat/v22-rc23-2026-10-22 (d27f3d73) src/v16_program.rs. All Rust counters
 * are u128, so every `checked_*` failure maps to `null`, `saturating_sub` to a clamp at 0.
 *
 * Rust reference (v16_program.rs):
 *   sync_backing_domain_ledger ........ :22098
 *   backing_unavailable_principal ..... :22043
 *   lp_vault_nav_atoms_floored ........ :22219
 *   backing_ledger_available_principal  :37201
 *   backing_ledger_over_impaired ...... :22328 (potDeficit > 0)
 *   lp_vault_impairment_exceeds ....... :22315
 *   (E3 `nonbound_available_e3` / lp_vault_pot_impairment_parts :22275 price off physical backing,
 *    not the ledger counters; the app ports the ledger reading of the 553d76f0 wrapper. Not
 *    compared here, see the PR notes.)
 */
import { describe, expect, it } from "vitest";
import {
  availablePrincipal,
  domainNav,
  potDeficit,
  potImpairmentParts,
  syncedLedger,
  vaultImpairmentExceeds,
  type DomainLedger,
  type DomainState,
} from "@/lib/limits/earn-split-pot";

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const BOUND_SCALE = 1_000_000_000_000n; // percolator BOUND_SCALE (lib/limits/constants.ts)

let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 2 ** 32;
}
const EDGES = [0n, 1n, 2n, 9_999n, 10_000n, 10_001n, 999_999n, 1_000_000n, U64 - 1n, U64];
function val(): bigint {
  const r = rnd();
  if (r < 0.35) return EDGES[Math.floor(rnd() * EDGES.length)];
  if (r < 0.7) return BigInt(Math.floor(rnd() * 1e6));
  return (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n | BigInt(Math.floor(rnd() * 2 ** 32))) & U64;
}
const FEES = [0, 1, 1, 5_000, 9_999, 10_000, 10_000];
function fee(): number {
  return rnd() < 0.5 ? FEES[Math.floor(rnd() * FEES.length)] : Math.floor(rnd() * 10_001);
}

// ── Rust transcriptions (u128; null = Err) ──────────────────────────────────────────────────
const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
const chk = (v: bigint) => (v > U128 ? null : v);

interface RLedger { principal: bigint; earnings: bigint; withdrawn: bigint; lastEarn: bigint; loss: bigint; rec: bigint; lastUnavail: bigint }
interface RBucket { consumed: bigint; impaired: bigint; fee: bigint }

function rustSync(l: RLedger, b: RBucket): RLedger | null {
  const o = { ...l };
  if (b.fee >= o.lastEarn) {
    const v = chk(o.earnings + (b.fee - o.lastEarn));
    if (v === null) return null;
    o.earnings = v;
  }
  o.lastEarn = b.fee;
  const un = chk(b.consumed + b.impaired);
  if (un === null) return null;
  const unavail = un / BOUND_SCALE;
  if (unavail >= o.lastUnavail) {
    const v = chk(o.loss + (unavail - o.lastUnavail));
    if (v === null) return null;
    o.loss = v;
  } else {
    const v = chk(o.rec + (o.lastUnavail - unavail));
    if (v === null) return null;
    o.rec = v;
  }
  o.lastUnavail = unavail;
  return o;
}
function rustAvailable(l: RLedger): bigint {
  return sat(l.principal, sat(l.loss, l.rec));
}
function rustNavFloored(l: RLedger, feeBps: number): bigint | null {
  if (BigInt(feeBps) > 10_000n) return null; // EngineInvalidConfig
  const avail = sat(l.principal, sat(l.loss, l.rec));
  if (l.earnings < l.withdrawn) return null; // checked_sub -> EngineCounterUnderflow
  const lpEarn = (l.earnings - l.withdrawn) * BigInt(feeBps) / 10_000n; // wide_mul_div_floor_u128
  return chk(avail + lpEarn);
}
const rustOverImpaired = (l: RLedger) => sat(l.loss, l.rec) > l.principal;
const rustExceeds = (imp: bigint, principal: bigint, maxBps: bigint) => imp > (principal * maxBps) / 10_000n;

const toTs = (l: RLedger): DomainLedger => ({
  totalPrincipal: l.principal,
  totalEarnings: l.earnings,
  totalEarningsWithdrawn: l.withdrawn,
  lastObsBucketEarnings: l.lastEarn,
  cumulativeLoss: l.loss,
  cumulativeRecovery: l.rec,
  lastObsUnavailable: l.lastUnavail,
});

function genLedger(): RLedger {
  const earnings = val();
  // withdrawn <= earnings by ledger construction, except in a few deliberate error rows
  const withdrawn = rnd() < 0.1 ? val() : (earnings === 0n ? 0n : val() % (earnings + 1n));
  return { principal: val(), earnings, withdrawn, lastEarn: val(), loss: val(), rec: val(), lastUnavail: val() };
}

const ROWS = 3000;
const rows = Array.from({ length: ROWS }, () => ({ l: genLedger(), f: fee(), b: { consumed: val() * BOUND_SCALE / 7n, impaired: val() * BOUND_SCALE / 5n, fee: val() } as RBucket }));

describe("earn-split-pot vs percolator-prog rc23 (seeded table)", () => {
  it("has >= 2000 rows", () => expect(rows.length).toBeGreaterThanOrEqual(2000));

  it("availablePrincipal(floored) == backing_ledger_available_principal_atoms", () => {
    for (const r of rows) expect(availablePrincipal(toTs(r.l), true)).toBe(rustAvailable(r.l));
  });

  it("domainNav(floored) == lp_vault_nav_atoms_floored (fee 0..10_000, net<0 -> null)", () => {
    for (const r of rows) expect(domainNav(toTs(r.l), r.f, true)).toBe(rustNavFloored(r.l, r.f));
  });

  it("domainNav floor-division at net==0 and fee 0 / 10_000 edges", () => {
    for (const n of [0n, 1n, 2n, 9_999n, 10_001n, U64]) {
      for (const f of [0, 1, 10_000]) {
        const l: RLedger = { principal: 5n, earnings: n, withdrawn: 0n, lastEarn: 0n, loss: 0n, rec: 0n, lastUnavail: 0n };
        expect(domainNav(toTs(l), f, true)).toBe(rustNavFloored(l, f));
      }
    }
  });

  it("syncedLedger == sync_backing_domain_ledger", () => {
    for (const r of rows) {
      const dom: DomainState = {
        bucket: { freshUnliened: 0n, validLiened: 0n, consumed: r.b.consumed, impaired: r.b.impaired, utilFeeEarnings: r.b.fee, status: 1 },
        source: { positiveClaimBound: 0n, freshReserved: 0n, validLienedBacking: 0n, insuranceCreditReserved: 0n, validLienedInsurance: 0n, impairedLienedInsurance: 0n },
        ledger: toTs(r.l),
      };
      const want = rustSync(r.l, r.b);
      if (want === null) continue; // u128 overflow is unreachable with u64-bounded counters
      expect(syncedLedger(dom)).toEqual(toTs(want));
    }
  });

  it("potDeficit > 0 == backing_ledger_over_impaired", () => {
    for (const r of rows) expect(potDeficit(toTs(r.l)) > 0n).toBe(rustOverImpaired(r.l));
  });

  it("vaultImpairmentExceeds == lp_vault_impairment_exceeds", () => {
    for (const r of rows) {
      const imp = val();
      const bps = [0n, 1n, 1_000n, 9_999n, 10_000n][Math.floor(rnd() * 5)];
      expect(vaultImpairmentExceeds(imp, r.l.principal, bps)).toBe(rustExceeds(imp, r.l.principal, bps));
    }
    expect(vaultImpairmentExceeds(5n, 0n)).toBe(true); // impairment > 0 with no principal
    expect(vaultImpairmentExceeds(0n, 0n)).toBe(false);
  });

  it("potImpairmentParts == ledger reading min(sat(loss-rec), principal)", () => {
    for (const r of rows) {
      const p = potImpairmentParts(toTs(r.l));
      expect(p.principal).toBe(r.l.principal);
      const rust = sat(r.l.loss, r.l.rec);
      expect(p.impairment).toBe(rust < r.l.principal ? rust : r.l.principal);
    }
  });
});
