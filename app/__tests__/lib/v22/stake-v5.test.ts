// @vitest-environment node
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CONSENT_VERSION_FIRST_LOSS_V5,
  STAKE_POOL_FIELD_OFF_V5,
  STAKE_POOL_SIZE_V5,
  STAKE_RISK_MODE,
  encodeStakeDepositWithConsentV5,
} from "@/lib/v22/sdk";
import { STAKE_CONSENT_TEXT_V2 } from "@/lib/v22/copy";
import { ConsentChangedError, buildStakeDepositV5Ix, consentKey, consentViewOf, pctOfBps, readFirstLossPool } from "@/lib/v22/stake-v5";

function poolBytes(o: { risk?: number; version?: number; target?: number; buffer?: number; hyst?: number; pendingBps?: bigint; pendingSlot?: bigint } = {}): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = o.version ?? 5;
  d[F.riskMode] = o.risk ?? STAKE_RISK_MODE.FirstLoss;
  d[F.consentVersion] = 2;
  v.setUint16(F.deployTargetBps, o.target ?? 5000, true);
  v.setUint16(F.liquidBufferBps, o.buffer ?? 3000, true);
  v.setUint16(F.hysteresisBps, o.hyst ?? 500, true);
  v.setBigUint64(F.pendingTargetBps, o.pendingBps ?? 0n, true);
  v.setBigUint64(F.pendingTargetSlot, o.pendingSlot ?? 0n, true);
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(Keypair.generate().publicKey.toBytes(), off);
  return d;
}

describe("stake v5 consent deposit bytes", () => {
  it("is exactly 16 bytes: [1][amount u64 LE][version 2][target u16][buffer u16][hysteresis u16]", () => {
    const amount = 1_234_567n;
    const got = encodeStakeDepositWithConsentV5(amount, { targetBps: 5000, bufferBps: 3000, hysteresisBps: 500 }, 2);
    // hand-computed: 1_234_567 = 0x12D687; 5000 = 0x1388; 3000 = 0x0BB8; 500 = 0x01F4
    const hand = Uint8Array.from([1, 0x87, 0xd6, 0x12, 0, 0, 0, 0, 0, 2, 0x88, 0x13, 0xb8, 0x0b, 0xf4, 0x01]);
    expect(got.length).toBe(16);
    expect(Array.from(got)).toEqual(Array.from(hand));
  });

  it("the built instruction carries those bytes, version 2, and the 14 accounts of ACCOUNTS_STAKE_DEPOSIT_V5", () => {
    const pool = readFirstLossPool(poolBytes())!;
    const k = () => Keypair.generate().publicKey;
    const ix = buildStakeDepositV5Ix({ stakeProgramId: k(), pool: k(), poolState: pool, user: k(), userCollateral: k(), userLp: k(), vaultAuthority: k(), depositPda: k(), amount: 1_234_567n });
    expect(ix.data.length).toBe(16);
    expect(ix.data[9]).toBe(CONSENT_VERSION_FIRST_LOSS_V5);
    expect(ix.keys.length).toBe(14);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[11].isWritable).toBe(true); // market writable on a first-loss pool
    expect(ix.keys[13].pubkey.equals(pool.percolatorProgram)).toBe(true);
  });

  it("signs the LARGER of the committed and a pending target (S-5)", () => {
    const pool = readFirstLossPool(poolBytes({ target: 4000, pendingBps: 6500n, pendingSlot: 10n }))!;
    expect(consentViewOf(pool).targetBps).toBe(6500);
    const ix = buildStakeDepositV5Ix({ stakeProgramId: PublicKey.default, pool: PublicKey.default, poolState: pool, user: PublicKey.default, userCollateral: PublicKey.default, userLp: PublicKey.default, vaultAuthority: PublicKey.default, depositPda: PublicKey.default, amount: 1n });
    expect(new DataView(ix.data.buffer, ix.data.byteOffset).getUint16(10, true)).toBe(6500);
  });
});

describe("pool detection", () => {
  it("a v5 first-loss pool is read; every other pool is null (existing UI untouched)", () => {
    expect(readFirstLossPool(poolBytes())).not.toBeNull();
    expect(readFirstLossPool(poolBytes({ risk: STAKE_RISK_MODE.FeeOnly }))).toBeNull();
    expect(readFirstLossPool(poolBytes({ risk: STAKE_RISK_MODE.Legacy }))).toBeNull();
    expect(readFirstLossPool(poolBytes({ version: 4 }))).toBeNull();
    expect(readFirstLossPool(new Uint8Array(392))).toBeNull();
    expect(readFirstLossPool(null)).toBeNull();
  });
  it("consent key changes whenever any signed number changes", () => {
    const a = consentKey(consentViewOf(readFirstLossPool(poolBytes())!));
    expect(consentKey(consentViewOf(readFirstLossPool(poolBytes({ target: 5100 }))!))).not.toBe(a);
    expect(consentKey(consentViewOf(readFirstLossPool(poolBytes({ buffer: 2900 }))!))).not.toBe(a);
    expect(consentKey(consentViewOf(readFirstLossPool(poolBytes({ hyst: 600 }))!))).not.toBe(a);
    expect(consentKey(consentViewOf(readFirstLossPool(poolBytes())!))).toBe(a);
  });
  it("ConsentChangedError carries the new numbers", () => {
    const now = consentViewOf(readFirstLossPool(poolBytes({ target: 7000 }))!);
    expect(new ConsentChangedError(now).now.targetBps).toBe(7000);
  });
  it("percent labels", () => {
    expect(pctOfBps(5000)).toBe("50%");
    expect(pctOfBps(550)).toBe("5.50%");
  });
});

describe("consent text v2", () => {
  it("has three paragraphs and the load-bearing v2 sentences", () => {
    expect(STAKE_CONSENT_TEXT_V2).toHaveLength(3);
    expect(STAKE_CONSENT_TEXT_V2[1]).toContain("up to the seniors' own loss that is still outstanding");
    expect(STAKE_CONSENT_TEXT_V2[1]).toContain("repayment is not guaranteed");
    expect(STAKE_CONSENT_TEXT_V2[2]).toContain("Withdrawals are paid only from the liquid part of the pool");
  });
  const repo = `${homedir()}/percolator-stake`;
  const src = (() => {
    try {
      if (!existsSync(repo)) return null;
      return execFileSync("git", ["-C", repo, "show", "origin/feat/v22-stake-v5:src/state.rs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { return null; }
  })();
  (src ? it : it.skip)("is word-for-word the doc comment on CONSENT_VERSION_FIRST_LOSS in stake state.rs", () => {
    const start = src!.indexOf("/// * Up to `deploy_target_bps`");
    const end = src!.indexOf("pub const CONSENT_VERSION_FIRST_LOSS: u8");
    const block = src!.slice(start, end).split("\n").map((l) => l.replace(/^\/\/\/\s?/, ""));
    const text = block.join(" ").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    const mine = STAKE_CONSENT_TEXT_V2.map((p) => `* ${p}`).join(" ").replace(/\s+/g, " ").trim();
    expect(mine).toBe(text);
  });
});
