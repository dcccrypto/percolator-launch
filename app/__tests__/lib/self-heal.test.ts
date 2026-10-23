// @vitest-environment node
/**
 * P0b client self-heal (lib/self-heal.ts).
 *
 * Fixtures: live devnet market bytes captured 2026-09-29 at slot 505580400
 * (same capture as percolator-oracle-keeper #130):
 *   paid    — domain-1 backing bucket Fresh but LAPSED.
 *   murphy  — both buckets lapsed + short side ResetPending (0 positions).
 *   collect — domain-1 lapsed + short side ResetPending.
 *   pengu   — healthy control.
 *
 * Negative controls are inline: every positive assertion has a paired case
 * where the triggering condition is removed and the repair must NOT appear.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { encodeExpireBackingBucket, parseBackingBucketsV17, IX_TAG } from "@percolatorct/sdk";
import {
  BUCKET_STATUS_FRESH,
  ENGINE_LOCK_ACTIVE_CODE,
  ENGINE_STALE_CODE,
  EXPIRE_BACKING_BUCKET_TAG,
  FINALIZE_RESET_SIDE_TAG,
  REPAIR_CU,
  buildLivenessRepairIx,
  decodeMarketLiveness,
  encodeExpireBackingBucketData,
  encodeFinalizeResetSideData,
  isRepairableFailure,
  planLivenessRepairs,
  planSelfHeal,
} from "@/lib/self-heal";
import type { SelfHealDeps } from "@/lib/self-heal";
import { modeFixtures } from "../helpers/v22-fixtures";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    Buffer.from(
      readFileSync(join(__dirname, "..", "fixtures", "v18-liveness", `${name}.b64`), "utf8").trim(),
      "base64",
    ),
  );

const CAPTURE_SLOT = 505580400n;
const PROGRAM = new PublicKey("GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ");
const MARKET = new PublicKey("BPLPf1XT7HE9qKwAbf4cSqcDrV6VHJDS3FPeQ3GL7JPY");
const OTHER_PROGRAM = new PublicKey("4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT"); // matcher

const plan = (name: string, slot = CAPTURE_SLOT) => planLivenessRepairs(decodeMarketLiveness(fixture(name), slot));

describe("decodeMarketLiveness — deployed layout vs live bytes", () => {
  for (const name of [
    "paid-market-v18-lapsed",
    "murphy-market-v18-lapsed",
    "collect-market-v18-lapsed",
    "pengu-market-v18-healthy",
  ]) {
    it(`${name}: buckets agree with the SDK's independent decoder`, () => {
      const ours = decodeMarketLiveness(fixture(name), CAPTURE_SLOT);
      const sdk = parseBackingBucketsV17(fixture(name), { chainSlot: CAPTURE_SLOT });
      expect(ours.buckets.map((b) => [b.domain, b.status, b.expirySlot])).toEqual(
        sdk.buckets.map((b) => [b.domain, b.status, BigInt(b.expirySlot)]),
      );
      expect(ours.mode).toBe(sdk.mode);
      expect(ours.nowSlot).toBe(sdk.nowSlot);
    });
  }

  it("reads the live ResetPending short side on COLLECT and Murphy (long side Normal)", () => {
    for (const name of ["collect-market-v18-lapsed", "murphy-market-v18-lapsed"]) {
      const s = decodeMarketLiveness(fixture(name), CAPTURE_SLOT);
      const a0 = s.sides.filter((x) => x.assetIndex === 0);
      expect(a0[1].mode).toBe(2);
      expect(a0[1].storedPos).toBe(0n);
      expect(a0[0].mode).toBe(0);
    }
  });

  it("rejects a truncated buffer", () => {
    // A real market of the ACTIVE mode cut to 1,000 B (header intact, slot region missing). A zero buffer is refused by the v2.2 guard for a
    // different reason (no wrapper magic), so the truncation control uses real bytes.
    expect(() => decodeMarketLiveness(modeFixtures().market.slice(0, 1000), 0n)).toThrow(/too short/);
  });
});

describe("planLivenessRepairs on live 2026-09-29 state", () => {
  it("PAID: expire lapsed domain 1 only", () => {
    expect(plan("paid-market-v18-lapsed")).toEqual([{ kind: "expire", domain: 1 }]);
  });
  it("Murphy: expire d0 + d1, finalize short", () => {
    expect(plan("murphy-market-v18-lapsed")).toEqual([
      { kind: "expire", domain: 0 },
      { kind: "expire", domain: 1 },
      { kind: "finalize", assetIndex: 0, side: 1 },
    ]);
  });
  it("COLLECT: expire d1, finalize short", () => {
    expect(plan("collect-market-v18-lapsed")).toEqual([
      { kind: "expire", domain: 1 },
      { kind: "finalize", assetIndex: 0, side: 1 },
    ]);
  });
  it("NEGATIVE CONTROL healthy PENGU: nothing", () => {
    expect(plan("pengu-market-v18-healthy")).toEqual([]);
  });
  it("NEGATIVE CONTROL: PAID read BEFORE its domain-1 expiry plans nothing for d1", () => {
    const s = decodeMarketLiveness(fixture("paid-market-v18-lapsed"), 0n);
    const d1 = s.buckets.find((b) => b.domain === 1)!;
    expect(d1.status).toBe(BUCKET_STATUS_FRESH);
    // Force the engine's own slot below expiry too (header.current_slot is also a floor).
    const early = { ...s, nowSlot: d1.expirySlot - 1n };
    expect(planLivenessRepairs(early).filter((r) => r.kind === "expire" && r.domain === 1)).toEqual([]);
    expect(planLivenessRepairs({ ...s, nowSlot: d1.expirySlot }).some((r) => r.kind === "expire" && r.domain === 1)).toBe(true);
  });
  it("NEGATIVE CONTROL: a non-Live market never plans an expiry", () => {
    const s = decodeMarketLiveness(fixture("murphy-market-v18-lapsed"), CAPTURE_SLOT);
    expect(planLivenessRepairs({ ...s, mode: 1 }).filter((r) => r.kind === "expire")).toEqual([]);
  });
  it("NEGATIVE CONTROL: a ResetPending side with a position / stale / obligation / barrier is not finalized", () => {
    const s = decodeMarketLiveness(fixture("collect-market-v18-lapsed"), CAPTURE_SLOT);
    for (const k of ["storedPos", "stale", "pendingObligations", "pendingDomainLossBarrier"] as const) {
      const sides = s.sides.map((x) => (x.side === 1 && x.assetIndex === 0 ? { ...x, [k]: 1n } : x));
      expect(planLivenessRepairs({ ...s, sides }).filter((r) => r.kind === "finalize")).toEqual([]);
    }
    const drainOnly = s.sides.map((x) => (x.side === 1 && x.assetIndex === 0 ? { ...x, mode: 1 } : x));
    expect(planLivenessRepairs({ ...s, sides: drainOnly }).filter((r) => r.kind === "finalize")).toEqual([]);
  });
});

describe("wire bytes match the deployed decode arms (6377376a)", () => {
  it("tag 89 = [89, domain u16 LE] and matches the SDK encoder", () => {
    expect(Array.from(encodeExpireBackingBucketData(1))).toEqual([89, 1, 0]);
    expect(Array.from(encodeExpireBackingBucketData(0x0203))).toEqual([89, 3, 2]);
    expect(EXPIRE_BACKING_BUCKET_TAG).toBe(IX_TAG.ExpireBackingBucket);
    expect(Array.from(encodeExpireBackingBucketData(1))).toEqual(Array.from(encodeExpireBackingBucket({ domain: 1 })));
  });
  it("tag 45 = [45, asset u16 LE, side u8]", () => {
    expect(Array.from(encodeFinalizeResetSideData(0, 1))).toEqual([45, 0, 0, 1]);
    expect(Array.from(encodeFinalizeResetSideData(0x0102, 0))).toEqual([45, 2, 1, 0]);
    expect(FINALIZE_RESET_SIDE_TAG).toBe(IX_TAG.FinalizeResetSide);
  });
  it("one account: the market, writable, not a signer", () => {
    const ix = buildLivenessRepairIx(PROGRAM, MARKET, { kind: "finalize", assetIndex: 0, side: 1 });
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    expect(ix.keys).toEqual([{ pubkey: MARKET, isSigner: false, isWritable: true }]);
  });
  it("rejects out-of-range arguments", () => {
    expect(() => encodeExpireBackingBucketData(-1)).toThrow();
    expect(() => encodeExpireBackingBucketData(0x10000)).toThrow();
    expect(() => encodeFinalizeResetSideData(1.5, 0)).toThrow();
  });
});

describe("isRepairableFailure — code overlap is routed by originating program", () => {
  const list = [
    ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
    new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([10]) }),
    new TransactionInstruction({ programId: OTHER_PROGRAM, keys: [], data: Buffer.from([0]) }),
  ];
  it("wrapper Custom(19) and Custom(21) are repairable", () => {
    expect(isRepairableFailure({ InstructionError: [2, { Custom: 19 }] }, list, PROGRAM)).toBe(true);
    expect(isRepairableFailure({ InstructionError: [2, { Custom: 21 }] }, list, PROGRAM)).toBe(true);
  });
  it("NEGATIVE CONTROL: the same code from the matcher is not", () => {
    expect(isRepairableFailure({ InstructionError: [3, { Custom: 21 }] }, list, PROGRAM)).toBe(false);
  });
  it("NEGATIVE CONTROL: other wrapper codes / non-custom errors are not", () => {
    expect(isRepairableFailure({ InstructionError: [2, { Custom: 49 }] }, list, PROGRAM)).toBe(false);
    expect(isRepairableFailure({ InstructionError: [2, "InvalidAccountData"] }, list, PROGRAM)).toBe(false);
    expect(isRepairableFailure("AccountNotFound", list, PROGRAM)).toBe(false);
    expect(isRepairableFailure({ InstructionError: [9, { Custom: 19 }] }, list, PROGRAM)).toBe(false);
  });
});

describe("planSelfHeal flow", () => {
  const userIx = new TransactionInstruction({
    programId: PROGRAM,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true }],
    data: Buffer.from([10, 1, 2, 3]),
  });
  const base = { programId: PROGRAM, market: MARKET, instructions: [userIx], computeUnits: 600_000 };

  /** Simulates the engine: the user's ix (last) fails `code` unless every needed repair precedes it. */
  function engineSim(fixtureName: string, code: number, opts: { failAfterRepair?: unknown } = {}): SelfHealDeps & { sims: TransactionInstruction[][] } {
    const sims: TransactionInstruction[][] = [];
    return {
      sims,
      readMarket: async () => ({ data: fixture(fixtureName), slot: CAPTURE_SLOT }),
      simulate: async (ixs) => {
        sims.push(ixs);
        const repaired = ixs.some((ix) => ix.data[0] === EXPIRE_BACKING_BUCKET_TAG || ix.data[0] === FINALIZE_RESET_SIDE_TAG);
        if (repaired) return { err: opts.failAfterRepair ?? null };
        return { err: { InstructionError: [ixs.length - 1, { Custom: code }] } };
      },
    };
  }

  it("PAID trade reverting Custom(19): prepends ExpireBackingBucket(d1) first, CU raised", async () => {
    const deps = engineSim("paid-market-v18-lapsed", ENGINE_STALE_CODE);
    const r = await planSelfHeal(base, deps);
    expect(r.outcome).toBe("repaired");
    expect(r.instructions).toHaveLength(2);
    expect(Array.from(r.instructions[0].data)).toEqual([89, 1, 0]);
    expect(r.instructions[1]).toBe(userIx);
    expect(r.computeUnits).toBe(600_000 + REPAIR_CU);
    expect(deps.sims).toHaveLength(2);
    // simulated txs carry the heap-frame prefix sendTx adds (wrapper aborts without it)
    expect(deps.sims[0][0].programId.equals(ComputeBudgetProgram.programId)).toBe(true);
  });

  it("Murphy Earn deposit reverting Custom(21): three repairs in engine order, before the user ix", async () => {
    const r = await planSelfHeal(base, engineSim("murphy-market-v18-lapsed", ENGINE_LOCK_ACTIVE_CODE));
    expect(r.outcome).toBe("repaired");
    expect(r.instructions.map((ix) => Array.from(ix.data))).toEqual([[89, 0, 0], [89, 1, 0], [45, 0, 0, 1], [10, 1, 2, 3]]);
  });

  it("a different remaining error after repair still uses the repaired list (truthful diagnosis)", async () => {
    const r = await planSelfHeal(
      base,
      engineSim("collect-market-v18-lapsed", ENGINE_LOCK_ACTIVE_CODE, { failAfterRepair: { InstructionError: [4, { Custom: 49 }] } }),
    );
    expect(r.outcome).toBe("repaired");
    expect(r.repairs).toHaveLength(2);
  });

  it("NEGATIVE CONTROL healthy market: no simulation at all, unchanged", async () => {
    const deps = engineSim("pengu-market-v18-healthy", ENGINE_STALE_CODE);
    const r = await planSelfHeal(base, deps);
    expect(r.outcome).toBe("no-repair-needed");
    expect(r.instructions).toBe(base.instructions);
    expect(deps.sims).toHaveLength(0);
  });

  it("NEGATIVE CONTROL user tx passes as-is on a market with a lapsed bucket: unchanged", async () => {
    const deps: SelfHealDeps = {
      readMarket: async () => ({ data: fixture("paid-market-v18-lapsed"), slot: CAPTURE_SLOT }),
      simulate: vi.fn(async () => ({ err: null })),
    };
    const r = await planSelfHeal(base, deps);
    expect(r.outcome).toBe("user-tx-ok");
    expect(r.instructions).toBe(base.instructions);
    expect(deps.simulate).toHaveBeenCalledTimes(1);
  });

  it("NEGATIVE CONTROL user tx fails with an unrelated code (Custom 49): unchanged, no second sim", async () => {
    const deps = engineSim("paid-market-v18-lapsed", 49);
    const r = await planSelfHeal(base, deps);
    expect(r.outcome).toBe("not-repairable");
    expect(r.instructions).toBe(base.instructions);
    expect(deps.sims).toHaveLength(1);
  });

  it("NEGATIVE CONTROL repair does not clear the 19/21: unchanged", async () => {
    const r = await planSelfHeal(
      base,
      engineSim("paid-market-v18-lapsed", ENGINE_STALE_CODE, { failAfterRepair: { InstructionError: [3, { Custom: 19 }] } }),
    );
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toBe(base.instructions);
  });

  it("RPC failure never throws and never modifies the tx", async () => {
    const r = await planSelfHeal(base, {
      readMarket: async () => { throw new Error("429"); },
      simulate: async () => ({ err: null }),
    });
    expect(r.outcome).toBe("rpc-error");
    expect(r.instructions).toBe(base.instructions);
  });
});
