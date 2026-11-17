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
import { describe, it, expect, vi, afterEach } from "vitest";
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
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { decodeAssetVaultLp } from "@/lib/limits/decode";
import {
  CATCH_UP_CRANK_CU,
  CATCH_UP_TOTAL_CU,
  MAX_REPAIRS,
  buildCatchUpCrankIx,
  computeBudgetPrefix,
  connectionSelfHealDeps,
  describeRepair,
  isSelfHealEnabled,
  parseCustomInstructionError,
  planCatchUp,
} from "@/lib/self-heal";

vi.mock("@/lib/limits/decode", async (orig) => {
  const actual = await orig<typeof import("@/lib/limits/decode")>();
  return { ...actual, decodeAssetVaultLp: vi.fn(actual.decodeAssetVaultLp) };
});

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

// ── Coverage extension: catch-up planning, give-up paths, connection deps ──────
const SLOT_LAST_OFF = 592 + 758 + 1024 + 41; // v2.1 constants (flag off)
const MAX_DT_OFF = 592 + 32 + 118;
const CUR_SLOT_OFF = 592 + 613;

/** A v2.1 healthy market with the clock fields set explicitly. */
function clockMarket(o: { slotLast: bigint; dt: bigint; headerSlot?: bigint }): Uint8Array {
  const d = fixture("pengu-market-v18-healthy").slice();
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  dv.setBigUint64(SLOT_LAST_OFF, o.slotLast, true);
  dv.setBigUint64(MAX_DT_OFF, o.dt, true);
  dv.setBigUint64(CUR_SLOT_OFF, o.headerSlot ?? 0n, true);
  return d;
}

afterEach(() => {
  __setDevnetV22ForTest(null);
  vi.mocked(decodeAssetVaultLp).mockClear();
  vi.unstubAllEnvs();
});

describe("small helpers", () => {
  it("describeRepair names both repair kinds and both sides", () => {
    expect(describeRepair({ kind: "expire", domain: 3 })).toBe("ExpireBackingBucket(domain 3)");
    expect(describeRepair({ kind: "finalize", assetIndex: 1, side: 0 })).toBe("FinalizeResetSide(asset 1, long)");
    expect(describeRepair({ kind: "finalize", assetIndex: 1, side: 1 })).toBe("FinalizeResetSide(asset 1, short)");
  });
  it("parseCustomInstructionError rejects every malformed shape", () => {
    expect(parseCustomInstructionError({ InstructionError: [1, { Custom: 5 }] })).toEqual({ index: 1, code: 5 });
    for (const bad of [null, undefined, "x", {}, { InstructionError: [1] }, { InstructionError: ["1", { Custom: 1 }] },
      { InstructionError: [1, null] }, { InstructionError: [1, { Custom: "1" }] }, { InstructionError: [1, "Err"] }]) {
      expect(parseCustomInstructionError(bad)).toBeNull();
    }
  });
  it("computeBudgetPrefix is heap frame then CU limit", () => {
    const p = computeBudgetPrefix(123_456);
    expect(p).toHaveLength(2);
    expect(p.every((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toBe(true);
  });
  it("encodeFinalizeResetSideData rejects an out-of-range asset", () => {
    expect(() => encodeFinalizeResetSideData(-1, 0)).toThrow(/bad asset/);
    expect(() => encodeFinalizeResetSideData(0x10000, 0)).toThrow(/bad asset/);
  });
  it("planLivenessRepairs caps the plan at MAX_REPAIRS", () => {
    const buckets = Array.from({ length: 12 }, (_, i) => ({ domain: i, status: BUCKET_STATUS_FRESH, expirySlot: 1n }));
    expect(planLivenessRepairs({ mode: 0, nowSlot: 10n, buckets, sides: [] })).toHaveLength(MAX_REPAIRS);
  });
  it("isSelfHealEnabled: default on, off for 0/false/off (case/space-insensitive)", () => {
    vi.stubEnv("NEXT_PUBLIC_SELF_HEAL", "");
    expect(isSelfHealEnabled()).toBe(true);
    for (const v of ["0", "false", "OFF", " off "]) {
      vi.stubEnv("NEXT_PUBLIC_SELF_HEAL", v);
      expect(isSelfHealEnabled()).toBe(false);
    }
    vi.stubEnv("NEXT_PUBLIC_SELF_HEAL", "1");
    expect(isSelfHealEnabled()).toBe(true);
  });
});

describe("planCatchUp", () => {
  it("no lag (now <= slotLast): k=0, not beyond cap", () => {
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 100n }), 1000n, 400_000);
    expect(r).toEqual({ k: 0, lagSlots: 0n, dtSlots: 100n, beyondCap: false });
  });
  it("lag 250 with dt 100 → ceil = 3 cranks", () => {
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 100n }), 1250n, 400_000);
    expect(r).toEqual({ k: 3, lagSlots: 250n, dtSlots: 100n, beyondCap: false });
  });
  it("header current_slot is a floor over the read slot", () => {
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 100n, headerSlot: 1100n }), 900n, 400_000);
    expect(r.lagSlots).toBe(100n);
    expect(r.k).toBe(1);
  });
  it("lag beyond the CU budget: k=0 and beyondCap", () => {
    // userCu 1.0M → kMax = floor(200k/25k) = 8; lag needs 20 cranks
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 10n }), 1200n, 1_000_000);
    expect(r).toEqual({ k: 0, lagSlots: 200n, dtSlots: 10n, beyondCap: true });
  });
  it("exactly at the cap is allowed", () => {
    const kMax = Math.floor((CATCH_UP_TOTAL_CU - 1_000_000) / CATCH_UP_CRANK_CU);
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 10n }), 1000n + BigInt(kMax) * 10n, 1_000_000);
    expect(r.k).toBe(kMax);
    expect(r.beyondCap).toBe(false);
  });
  it("userCu above the total budget: kMax clamps to 0 → beyondCap", () => {
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 10n }), 1005n, CATCH_UP_TOTAL_CU + 500_000);
    expect(r.beyondCap).toBe(true);
    expect(r.k).toBe(0);
  });
  it("slotLast 0 or dt 0 (unset): nothing to plan, dt reported null for 0", () => {
    expect(planCatchUp(clockMarket({ slotLast: 0n, dt: 100n }), 5000n, 1).k).toBe(0);
    const r = planCatchUp(clockMarket({ slotLast: 1000n, dt: 0n }), 5000n, 1);
    expect(r).toEqual({ k: 0, lagSlots: 0n, dtSlots: null, beyondCap: false });
  });
  it("buffer too short for the fields: null readers → no plan", () => {
    expect(planCatchUp(new Uint8Array(100), 5000n, 1)).toEqual({ k: 0, lagSlots: 0n, dtSlots: null, beyondCap: false });
  });
  it("v2.2 flag on + unknown layout: offsets null → no plan, no throw", () => {
    __setDevnetV22ForTest(true);
    const r = planCatchUp(new Uint8Array(4096), 5000n, 1);
    expect(r.k).toBe(0);
    expect(r.beyondCap).toBe(false);
  });
  it("v2.2 flag on + real v2.2 market: resolves VERSION offsets and does not throw", () => {
    __setDevnetV22ForTest(true);
    const r = planCatchUp(modeFixtures().market, 10n ** 12n, 400_000);
    expect(typeof r.k).toBe("number");
    expect(r.k).toBeGreaterThanOrEqual(0);
  });
});

describe("buildCatchUpCrankIx", () => {
  it("keys are [cranker, market, portfolio, ...oracleTail]", () => {
    const cranker = Keypair.generate().publicKey;
    const portfolio = Keypair.generate().publicKey;
    const tail = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false };
    const ix = buildCatchUpCrankIx(PROGRAM, cranker, MARKET, portfolio, [tail]);
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    expect(ix.keys.map((k) => k.pubkey.toBase58()).slice(0, 4)).toEqual(
      [cranker, MARKET, portfolio, tail.pubkey].map((k) => k.toBase58()),
    );
    expect(ix.keys).toHaveLength(4);
    expect(buildCatchUpCrankIx(PROGRAM, cranker, MARKET, portfolio).keys).toHaveLength(3);
  });
});

describe("planSelfHeal — catch-up and give-up paths", () => {
  const userIx = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([10, 9]) });
  const cranker = Keypair.generate().publicKey;
  const portfolio = Keypair.generate().publicKey;
  const base = { programId: PROGRAM, market: MARKET, instructions: [userIx], computeUnits: 400_000 };
  const lagging = clockMarket({ slotLast: 1000n, dt: 100n });

  const sim = (results: unknown[]) => {
    const sims: TransactionInstruction[][] = [];
    let i = 0;
    return {
      sims,
      deps: {
        readMarket: async () => ({ data: lagging, slot: 1250n }),
        simulate: async (ixs: TransactionInstruction[]) => {
          sims.push(ixs);
          return { err: results[Math.min(i++, results.length - 1)] };
        },
      } satisfies SelfHealDeps,
    };
  };
  const stale = (idx: number) => ({ InstructionError: [idx, { Custom: ENGINE_STALE_CODE }] });

  it("lagging clock + catchUp portfolio: prepends k cranks, CU raised, outcome repaired", async () => {
    const { sims, deps } = sim([stale(2), null]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio } }, deps);
    expect(r.outcome).toBe("repaired");
    expect(r.catchUpCranks).toBe(3);
    expect(r.repairs).toEqual([]);
    expect(r.instructions).toHaveLength(4);
    expect(r.instructions[3]).toBe(userIx);
    expect(r.computeUnits).toBe(400_000 + 3 * CATCH_UP_CRANK_CU);
    expect(sims).toHaveLength(2);
    expect(vi.mocked(decodeAssetVaultLp)).not.toHaveBeenCalled();
  });

  it("catch-up cranks do not help: repair-did-not-help, unchanged list", async () => {
    const { sims, deps } = sim([stale(2), stale(5)]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio } }, deps);
    expect(r.outcome).toBe("repair-did-not-help");
    expect(r.instructions).toBe(base.instructions);
    expect(r.computeUnits).toBe(400_000);
    expect(r.repairs).toEqual([]);
    expect(r.catchUpBeyondCap).toBe(false);
    expect(sims).toHaveLength(2);
  });

  it("lag beyond cap: no cranks, no simulation, flagged for the keeper", async () => {
    const { sims, deps } = sim([stale(2)]);
    const r = await planSelfHeal({ ...base, computeUnits: 1_000_000, catchUp: { cranker, portfolio } }, {
      ...deps,
      readMarket: async () => ({ data: clockMarket({ slotLast: 1000n, dt: 10n }), slot: 5000n }),
    });
    expect(r.outcome).toBe("no-repair-needed");
    expect(r.catchUpBeyondCap).toBe(true);
    expect(r.instructions).toBe(base.instructions);
    expect(sims).toHaveLength(0);
  });

  it("repair-did-not-help carries catchUpBeyondCap=false and a repair+crank mix leaves repairs recorded", async () => {
    const paid = fixture("paid-market-v18-lapsed").slice();
    const dv = new DataView(paid.buffer, paid.byteOffset, paid.byteLength);
    dv.setBigUint64(SLOT_LAST_OFF, CAPTURE_SLOT - 200n, true);
    dv.setBigUint64(MAX_DT_OFF, 100n, true);
    const sims: TransactionInstruction[][] = [];
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio, oracleTail: [] } }, {
      readMarket: async () => ({ data: paid, slot: CAPTURE_SLOT }),
      simulate: async (ixs) => { sims.push(ixs); return { err: sims.length === 1 ? stale(2) : null }; },
    });
    expect(r.outcome).toBe("repaired");
    expect(r.repairs).toEqual([{ kind: "expire", domain: 1 }]);
    expect(r.catchUpCranks).toBe(2);
    expect(r.computeUnits).toBe(400_000 + REPAIR_CU + 2 * CATCH_UP_CRANK_CU);
    // cranks first, then the repair, then the user ix
    expect(r.instructions.map((ix) => ix.data[0]).slice(-2)).toEqual([EXPIRE_BACKING_BUCKET_TAG, 10]);
  });

  it("portfolio null + unbound/undecodable vault LP: no cranks, no repairs → no-repair-needed", async () => {
    const { sims, deps } = sim([stale(2)]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio: null } }, deps);
    expect(vi.mocked(decodeAssetVaultLp)).toHaveBeenCalledTimes(1);
    expect(r.outcome).toBe("no-repair-needed");
    expect(r.catchUpCranks).toBeUndefined();
    expect(sims).toHaveLength(0);
  });

  it("portfolio null + bound vault LP: cranks use the bound LP portfolio", async () => {
    const lp = Keypair.generate().publicKey;
    vi.mocked(decodeAssetVaultLp).mockReturnValueOnce({ bound: true, vaultLpPortfolio: lp.toBytes() } as ReturnType<typeof decodeAssetVaultLp>);
    const { deps } = sim([stale(2), null]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio: null } }, deps);
    expect(r.outcome).toBe("repaired");
    expect(r.catchUpCranks).toBe(3);
    expect(r.instructions[0].keys[2].pubkey.equals(lp)).toBe(true);
  });

  it("portfolio null + decoded but unbound LP: no cranks", async () => {
    vi.mocked(decodeAssetVaultLp).mockReturnValueOnce({ bound: false, vaultLpPortfolio: new Uint8Array(32) } as ReturnType<typeof decodeAssetVaultLp>);
    const { deps } = sim([stale(2)]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio: null } }, deps);
    expect(r.outcome).toBe("no-repair-needed");
  });

  it("second simulation throws: never throws out, unchanged with rpc-error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio } }, {
      readMarket: async () => ({ data: lagging, slot: 1250n }),
      simulate: async () => { if (n++ === 0) return { err: stale(2) }; throw new Error("boom"); },
    });
    expect(r.outcome).toBe("rpc-error");
    expect(r.instructions).toBe(base.instructions);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("market account missing: no-repair-needed, no simulation", async () => {
    const simulate = vi.fn(async () => ({ err: null }));
    const r = await planSelfHeal(base, { readMarket: async () => null, simulate });
    expect(r.outcome).toBe("no-repair-needed");
    expect(simulate).not.toHaveBeenCalled();
  });

  it("repair-did-not-help with a failing matcher-side error is NOT a give-up (repaired list used)", async () => {
    const { deps } = sim([stale(2), { InstructionError: [3, { Custom: 49 }] }]);
    const r = await planSelfHeal({ ...base, catchUp: { cranker, portfolio } }, deps);
    expect(r.outcome).toBe("repaired");
  });
});

describe("connectionSelfHealDeps", () => {
  const payer = Keypair.generate().publicKey;
  const ix = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([1]) });

  it("readMarket returns data + context slot, or null when the account is missing", async () => {
    const getAccountInfoAndContext = vi
      .fn()
      .mockResolvedValueOnce({ value: { data: Buffer.from([1, 2, 3]) }, context: { slot: 77 } })
      .mockResolvedValueOnce({ value: null, context: { slot: 78 } });
    const deps = connectionSelfHealDeps({ getAccountInfoAndContext } as never, MARKET, payer);
    const got = await deps.readMarket();
    expect(Array.from(got!.data)).toEqual([1, 2, 3]);
    expect(got!.slot).toBe(77n);
    expect(await deps.readMarket()).toBeNull();
    expect(getAccountInfoAndContext).toHaveBeenCalledWith(MARKET, "confirmed");
  });

  it("simulate sends an unsigned versioned tx with replaceRecentBlockhash and returns sim err", async () => {
    const simulateTransaction = vi.fn().mockResolvedValue({ value: { err: { InstructionError: [0, { Custom: 19 }] } } });
    const deps = connectionSelfHealDeps({ simulateTransaction } as never, MARKET, payer);
    const r = await deps.simulate([ix]);
    expect(r.err).toEqual({ InstructionError: [0, { Custom: 19 }] });
    const [tx, opts] = simulateTransaction.mock.calls[0];
    expect(opts).toEqual({ replaceRecentBlockhash: true, sigVerify: false, commitment: "confirmed" });
    expect(tx.message.staticAccountKeys[0].equals(payer)).toBe(true);
  });
});
