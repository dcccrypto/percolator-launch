import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Keypair } from "@solana/web3.js";
import { bindInsuranceAuthorityAccounts } from "@percolatorct/sdk";
import { FirstLossDeposit } from "@/components/stake/FirstLossDeposit";
import { bindPoolWritableViolations, type NeutralIx } from "@/lib/launch-single-tx/shape";
import { V22_COPY } from "@/lib/v22/copy";
import { STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, STAKE_RISK_MODE, closeoutCreatorShare, closeoutSplit, decodeStakePoolV5 } from "@/lib/v22/sdk";
import { stakePoolValueView } from "@/lib/v22/stake-pool-value";

const hook = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock("@/hooks/useStakeFirstLoss", () => ({ useStakeFirstLoss: () => ({ pool: hook.pool, deposit: vi.fn(), loading: false, error: null }) }));
afterEach(cleanup);

describe("tag 19 (BindInsuranceAuthority): the pool is writable", () => {
  const k = () => Keypair.generate().publicKey;
  it("the builder the launch uses marks the pool (account 1) writable; the older program only reads it, so writable is accepted there too", () => {
    const keys = bindInsuranceAuthorityAccounts({ admin: k(), poolPda: k(), vaultAuth: k(), slab: k(), percolatorProgram: k() });
    expect(keys[1]!.isWritable).toBe(true);
    expect(keys[0]).toMatchObject({ isSigner: true });
  });
  const ix = (writable: boolean): NeutralIx => ({
    programId: "S",
    accounts: ["a", "pool", "va", "slab", "prog"].map((key, i) => ({ key, signer: i === 0, writable: i === 1 ? writable : i === 3 })),
    data: Uint8Array.of(19),
  });
  it("the launch shape refuses a bind with a read-only pool", () => {
    expect(bindPoolWritableViolations(ix(true), 7)).toEqual([]);
    expect(bindPoolWritableViolations(ix(false), 7)).toEqual(["ix 7: stake.BindInsuranceAuthority must mark the pool (account 1) writable"]);
    expect(bindPoolWritableViolations({ ...ix(true), accounts: [] }, 3)).toHaveLength(1);
  });
});

describe("close-out split (port of stake closeout_split)", () => {
  it("creator gets at most the seed; the rest goes to stakers", () => {
    expect(closeoutSplit({ surplus: 7_000n, seed: 5_000n, forwarded: 0n, hasRealStakers: true })).toEqual({ creator: 5_000n, stakers: 2_000n, unclaimed: 0n });
  });
  it("seed above the surplus: the creator gets what is left after losses", () => {
    expect(closeoutSplit({ surplus: 3_000n, seed: 5_000n, forwarded: 0n, hasRealStakers: true })).toEqual({ creator: 3_000n, stakers: 0n, unclaimed: 0n });
    expect(closeoutCreatorShare(3_000n, 5_000n, 1_000n)).toBe(3_000n);
    expect(closeoutCreatorShare(9_000n, 5_000n, 1_000n)).toBe(4_000n);
  });
  it("nobody staked: the rest is unclaimed, never the creator's", () => {
    expect(closeoutSplit({ surplus: 7_600n, seed: 5_000n, forwarded: 0n, hasRealStakers: false })).toEqual({ creator: 5_000n, stakers: 0n, unclaimed: 2_600n });
  });
});

function poolBytes(o: { unclaimed?: bigint; seed?: bigint; risk?: number } = {}): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5;
  d[F.riskMode] = o.risk ?? STAKE_RISK_MODE.FeeOnly;
  d[F.consentVersion] = 2;
  new DataView(d.buffer).setUint16(F.deployTargetBps, 5000, true);
  new DataView(d.buffer).setUint16(F.liquidBufferBps, 3000, true);
  new DataView(d.buffer).setUint16(F.hysteresisBps, 500, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  const u = o.unclaimed ?? 0n;
  for (let i = 0; i < 7; i++) d[281 + i] = Number((u >> BigInt(8 * i)) & 0xffn);
  d[334] = Number((u >> 56n) & 0xffn);
  if (o.seed !== undefined) {
    d[333] = 1;
    for (let i = 0; i < 7; i++) d[457 + i] = Number((o.seed >> BigInt(8 * i)) & 0xffn);
  }
  return d;
}

describe("decoder: seed and unclaimed", () => {
  it("unclaimed is a full u64 (low 7 bytes + the high byte)", () => {
    expect(decodeStakePoolV5(poolBytes({ unclaimed: 0n })).unclaimedAtoms).toBe(0n);
    expect(decodeStakePoolV5(poolBytes({ unclaimed: 2_600_000n })).unclaimedAtoms).toBe(2_600_000n);
    expect(decodeStakePoolV5(poolBytes({ unclaimed: (1n << 63n) + 5n })).unclaimedAtoms).toBe((1n << 63n) + 5n);
  });
  it("the seed is only valid when the bind recorded it", () => {
    expect(decodeStakePoolV5(poolBytes()).creatorSeedAtoms).toBeNull();
    expect(decodeStakePoolV5(poolBytes({ seed: 5_000_000n })).creatorSeedAtoms).toBe(5_000_000n);
  });
  it("the pool view carries the unclaimed amount", () => {
    expect(stakePoolValueView(poolBytes({ unclaimed: 2_600_000n }), null)?.unclaimedAtoms).toBe(2_600_000n);
  });
});

describe("close-out copy", () => {
  it("the one-line strings", () => {
    expect(V22_COPY.growth.creatorSeed).toBe("If this market closes, you get back your insurance seed (or what's left of it after losses). Anything above it goes to stakers.");
    expect(V22_COPY.stake.closeOut.feeOnly).toBe("Fee-only stakers earn nothing while the market runs. When it closes, you share everything above the creator's seed, in proportion to your stake.");
    expect(V22_COPY.stake.closeOut.firstLoss).toBe("At close, you share everything above the creator's seed in proportion to your stake.");
    expect(V22_COPY.stake.unclaimed("$2.6")).toBe("$2.6 left in the closed pool, not claimable");
  });
  it("a first-loss deposit keeps the risk line and adds the close-out line", () => {
    hook.pool = { riskMode: 1, consentVersion: 2, deployTargetBps: 5000, liquidBufferBps: 3000, hysteresisBps: 500 };
    render(<FirstLossDeposit slabAddress="S" collateralMint="M" decimals={6} />);
    expect(screen.getByTestId("consent-summary")).toHaveTextContent(V22_COPY.stake.consentSummary);
    expect(screen.getByTestId("consent-closeout")).toHaveTextContent("At close, you share everything above the creator's seed in proportion to your stake.");
  });
  it("no line still says the creator gets the fund back in full or that fee-only stakers earn fees while the market runs", () => {
    const all = JSON.stringify(V22_COPY.stake) + JSON.stringify(V22_COPY.growth);
    expect(all).not.toMatch(/all of it if nobody staked|earn fees|paid the insurance share/i);
  });
});
