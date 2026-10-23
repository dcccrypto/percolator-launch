import "@testing-library/jest-dom";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { ACCOUNT_KIND, INSURANCE_UNITS_FIELD_OFF_V22, LAYOUT_V22, STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, STAKE_RISK_MODE, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { atomsToUsd, isInsuranceOnly, stakePoolValueView } from "@/lib/v22/stake-pool-value";
import { V22_COPY } from "@/lib/v22/copy";
import { FirstLossDeposit } from "@/components/stake/FirstLossDeposit";
import { vi } from "vitest";

const hook = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock("@/hooks/useStakeFirstLoss", () => ({ useStakeFirstLoss: () => ({ pool: hook.pool, deposit: vi.fn(), loading: false, error: null }) }));

afterEach(cleanup);
const M = 1_000_000n;

function poolBytes(o: { risk?: number; deposited?: bigint; withdrawn?: bigint; flushed?: bigint; returned?: bigint; fees?: bigint; junior?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5;
  d[F.riskMode] = o.risk ?? STAKE_RISK_MODE.FirstLoss;
  d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, 5000, true);
  v.setUint16(F.liquidBufferBps, 3000, true);
  v.setUint16(F.hysteresisBps, 500, true);
  v.setBigUint64(168, o.deposited ?? 0n, true);
  v.setBigUint64(216, o.withdrawn ?? 0n, true);
  v.setBigUint64(200, o.flushed ?? 0n, true);
  v.setBigUint64(208, o.returned ?? 0n, true);
  v.setBigUint64(256, o.fees ?? 0n, true);
  v.setBigUint64(F.reserved + 51, o.junior ?? 0n, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  return d;
}

function unitsBytes(stake: bigint, creator: bigint, free: bigint): Uint8Array {
  const d = new Uint8Array(16 + 192);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = ACCOUNT_KIND.InsuranceUnits;
  const b = 16;
  const F = INSURANCE_UNITS_FIELD_OFF_V22;
  d.set(Keypair.generate().publicKey.toBytes(), b + F.marketGroup);
  const u128 = (o: number, x: bigint) => { v.setBigUint64(b + o, x & ((1n << 64n) - 1n), true); v.setBigUint64(b + o + 8, x >> 64n, true); };
  u128(F.unitsTotal, stake + creator);
  u128(F.unitsStake, stake);
  u128(F.unitsCreator, creator);
  u128(F.snapInsuranceMintAtoms, free);
  u128(F.snapInsuranceFreeAtoms, free);
  d[b + F.version] = 1;
  return d;
}

describe("stake pool value includes deployed insurance (checklist 5.4)", () => {
  it("first-loss: liquid + floor(unitsStake * insurance / unitsTotal)", () => {
    // deposited 1000, 400 flushed to insurance => liquid 600; stakers own 60% of units of a 500 fund => deployed 300
    const v = stakePoolValueView(poolBytes({ deposited: 1_000n * M, flushed: 400n * M }), unitsBytes(600n, 400n, 500n * M))!;
    expect(v.kind).toBe("first-loss");
    expect(v.liquidAtoms).toBe(600n * M);
    expect(v.deployedAtoms).toBe(300n * M);
    expect(v.totalAtoms).toBe(900n * M);
    expect(atomsToUsd(v.deployedAtoms)).toBe(300);
  });
  it("a loss in the insurance fund lowers the deployed part pro rata, never the liquid part", () => {
    const v = stakePoolValueView(poolBytes({ deposited: 1_000n * M, flushed: 400n * M }), unitsBytes(600n, 400n, 250n * M))!;
    expect(v.deployedAtoms).toBe(150n * M);
    expect(v.totalAtoms).toBe(750n * M);
  });
  it("fees add to liquid, a realized junior loss subtracts", () => {
    const v = stakePoolValueView(poolBytes({ deposited: 100n * M, fees: 7n * M, junior: 2n * M }), unitsBytes(1n, 0n, 0n))!;
    expect(v.liquidAtoms).toBe(105n * M);
  });
  it("floors the deployed share", () => {
    const v = stakePoolValueView(poolBytes({ deposited: 10n }), unitsBytes(1n, 2n, 10n))!;
    expect(v.deployedAtoms).toBe(3n);
  });
  it("first-loss with unreadable units: no number at all (a dash), never a guess", () => {
    const p = poolBytes({ deposited: 1_000n * M });
    expect(stakePoolValueView(p, null)).toMatchObject({ kind: "first-loss", liquidAtoms: null, deployedAtoms: null, totalAtoms: null });
    expect(stakePoolValueView(p, new Uint8Array(40))).toMatchObject({ totalAtoms: null });
    expect(atomsToUsd(null)).toBeNull();
  });
  it("fee-only and legacy pools deploy nothing and keep their own kind (the 'Fee staking' naming)", () => {
    const f = stakePoolValueView(poolBytes({ risk: STAKE_RISK_MODE.FeeOnly, deposited: 50n * M }), null)!;
    expect(f).toMatchObject({ kind: "fee-only", deployedAtoms: 0n, totalAtoms: 50n * M });
    const l = stakePoolValueView(poolBytes({ risk: STAKE_RISK_MODE.Legacy, deposited: 50n * M }), null)!;
    expect(l.kind).toBe("legacy");
  });
  it("not a v5 pool: null, the caller keeps its legacy math", () => {
    expect(stakePoolValueView(new Uint8Array(400), null)).toBeNull();
  });
});

describe("naming: insurance staking only for first-loss pools", () => {
  it("all first-loss: Insurance staking; any fee-only / legacy / flag-off pool: Fee staking", () => {
    expect(isInsuranceOnly([{ stakeKind: "first-loss" }, { stakeKind: "first-loss" }])).toBe(true);
    expect(isInsuranceOnly([{ stakeKind: "first-loss" }, { stakeKind: "fee-only" }])).toBe(false);
    expect(isInsuranceOnly([{ stakeKind: "legacy" }])).toBe(false);
    expect(isInsuranceOnly([{}])).toBe(false);
    expect(isInsuranceOnly([])).toBe(false);
  });
});

describe("FirstLossDeposit: deployed line and the one-paragraph risk summary", () => {
  const pool = { riskMode: 1, consentVersion: 2, deployTargetBps: 5000, liquidBufferBps: 3000, hysteresisBps: 500 };
  const props = { slabAddress: "S", collateralMint: "M", decimals: 6 };
  it("shows 'Deployed to insurance: $X' and the summary above the program's own text", () => {
    hook.pool = pool;
    render(<FirstLossDeposit {...props} deployedUsd={1234.5} />);
    expect(screen.getByTestId("fl-deployed")).toHaveTextContent("Deployed to insurance: $1,234.50");
    expect(screen.getByTestId("consent-summary")).toHaveTextContent(V22_COPY.stake.consentSummary);
    expect(V22_COPY.stake.consentSummary).toBe("Staking insures this market's backstop: you can lose part of your stake if losses exceed the creator's tranche, bonds and Earn.");
  });
  it("unreadable deployed value shows a dash, absent prop shows nothing", () => {
    hook.pool = pool;
    const { rerender } = render(<FirstLossDeposit {...props} deployedUsd={null} />);
    expect(screen.getByTestId("fl-deployed")).toHaveTextContent("Deployed to insurance: —");
    rerender(<FirstLossDeposit {...props} />);
    expect(screen.queryByTestId("fl-deployed")).toBeNull();
  });
});
