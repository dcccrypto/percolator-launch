// D5 (v22 deep memo 2026-10-29): the wizard states the pool type on the wire. Plain InitPool (16 bytes) creates a FIRST_LOSS
// pool on the v2.2 stake program, so with the v2.2 flag on the wizard sends InitPoolV5 with risk mode FEE_ONLY (2), target 0.
import { describe, it, expect } from "vitest";
import { buildStakeInitPoolData } from "@/lib/v22/stake-v5";
import { STAKE_RISK_MODE } from "@/lib/v22/sdk";
import { encodeStakeInitPool } from "@percolatorct/sdk";
import { STAKE_POOL_COOLDOWN_SLOTS } from "@/lib/earn-vault-seed";

const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);

describe("buildStakeInitPoolData", () => {
  it("v2.2 on: InitPoolV5, 24 bytes, FEE_ONLY (2), cooldown 150, uncapped, target 0, default buffer / hysteresis", () => {
    const d = buildStakeInitPoolData(true, STAKE_POOL_COOLDOWN_SLOTS);
    expect(d.length).toBe(24);
    expect(d[0]).toBe(0);
    expect(new DataView(d.buffer, d.byteOffset).getBigUint64(1, true)).toBe(150n);
    expect(new DataView(d.buffer, d.byteOffset).getBigUint64(9, true)).toBe(0n);
    expect(d[17]).toBe(2);
    expect(STAKE_RISK_MODE.FeeOnly).toBe(2);
    expect(u16(d, 18)).toBe(0);
    expect(u16(d, 20)).toBe(3000);
    expect(u16(d, 22)).toBe(500);
  });
  it("v2.2 off: the legacy 17-byte InitPool is unchanged", () => {
    expect(Array.from(buildStakeInitPoolData(false, 150n))).toEqual(Array.from(encodeStakeInitPool(150n, 0n)));
  });
  it("the hook builds the pool data through the helper at both sites and never calls plain encodeStakeInitPool", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/hooks/useCreateMarket.ts`, "utf8");
    expect(src.match(/buildStakeInitPoolData\(isDevnetV22Enabled\(\), STAKE_POOL_COOLDOWN_SLOTS\)/g)?.length).toBe(2);
    expect(src).not.toMatch(/data: encodeStakeInitPool\(/);
  });
});
