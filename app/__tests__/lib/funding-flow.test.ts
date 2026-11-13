/** r10 owner decision 1: funding the chain moved on a position = counter change since open + the leg's pending funding (engine f_delta). */
import { describe, expect, it } from "vitest";
import { fundingPaidSoFar, fundingSampleOf, pendingFundingPaidAtoms } from "@/lib/funding-flow";
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";

const A = 1_000_000_000_000_000n; // a_basis
const asset = (o: Partial<AssetSettleState> = {}): AssetSettleState => ({
  effectivePriceE6: 100_000_000n, kLong: 0n, kShort: 0n, fLong: 0n, fShort: 0n, kfEpochLong: 3n, kfEpochShort: 3n, bLong: 0n, bShort: 0n, epochLong: 1n, epochShort: 1n, ...o,
});
const leg = (o: Partial<RiskLegSnap> = {}): RiskLegSnap => ({ side: 0, kSnap: 0n, fSnap: 0n, kfEpochSnap: 3n, epochSnap: 1n, bSnap: 0n, bEpochSnap: 1n, stale: false, bStale: false, ...o });

describe("fundingSampleOf", () => {
  it("net = paid (long + short) - received (long + short); counts active legs", () => {
    expect(fundingSampleOf({ fundingLongPaidAtomsTotal: 100n, fundingLongReceivedAtomsTotal: 5n, fundingShortPaidAtomsTotal: 7n, fundingShortReceivedAtomsTotal: 20n, legs: [{ active: true }, { active: false }] })).toEqual({ netPaid: 82n, legs: 1 });
  });
});

describe("pendingFundingPaidAtoms (engine f_delta = floor(|basis| x dF / (a_basis x 1e6)), paid = -f_delta)", () => {
  const basis = 2_000_000n; // 2 tokens
  it("a long whose side index fell (longs pay) has pending funding PAID", () => {
    // basis 2e6 x dF(-1.5 a_basis) / (a_basis x 1e6) = -3 atoms
    const dF = -(A * 3n) / 2n;
    expect(pendingFundingPaidAtoms(asset({ fLong: dF }), leg(), basis, A)).toBe(3n);
  });
  it("a rise is funding received (negative paid); the signed floor rounds the engine's way (toward more paid)", () => {
    expect(pendingFundingPaidAtoms(asset({ fLong: (A * 3n) / 2n }), leg(), basis, A)).toBe(-3n);
    // f_delta = floor(-2.5) = -3 => paid 3
    expect(pendingFundingPaidAtoms(asset({ fLong: -(A * 5n) / 4n }), leg(), basis, A)).toBe(3n);
  });
  it("a short reads the short index; nothing accrued is 0", () => {
    expect(pendingFundingPaidAtoms(asset({ fShort: -A }), leg({ side: 1 }), -basis, A)).toBe(2n);
    expect(pendingFundingPaidAtoms(asset(), leg(), basis, A)).toBe(0n);
  });
  it("NEGATIVE: a leg on an older epoch / stale / missing input is unknown, never zero", () => {
    expect(pendingFundingPaidAtoms(asset({ epochLong: 2n }), leg(), basis, A)).toBeNull();
    expect(pendingFundingPaidAtoms(asset({ kfEpochLong: 4n }), leg(), basis, A)).toBeNull();
    expect(pendingFundingPaidAtoms(asset(), leg({ stale: true }), basis, A)).toBeNull();
    expect(pendingFundingPaidAtoms(null, leg(), basis, A)).toBeNull();
    expect(pendingFundingPaidAtoms(asset(), leg(), basis, 0n)).toBeNull();
  });
});

describe("fundingPaidSoFar", () => {
  it("settled since open plus pending; any unknown part makes it unknown", () => {
    expect(fundingPaidSoFar(100n, 160n, 3n)).toBe(63n);
    expect(fundingPaidSoFar(null, 160n, 3n)).toBeNull();
    expect(fundingPaidSoFar(100n, null, 3n)).toBeNull();
    expect(fundingPaidSoFar(100n, 160n, null)).toBeNull();
  });
});
