/**
 * Fee-split wiring in the create flow.
 *
 * 1. Tag-86 (UpdateFeeSplit) wire bytes: tag(1) + 3× u16 LE shares + u64 LE
 *    authority_epoch = 15 bytes. The u64 anti-replay epoch was added in the v18
 *    wire (deployed wrapper 553d76f0, src/v16_program.rs tag-86 decode) and
 *    adopted by the app in 0d975d00; this test predated it (7-byte v17 shape).
 * 2. Sequence invariant (orderStakeTailInstructions): UpdateFeeSplit MUST come
 *    BEFORE StakeInitPool (which irreversibly rotates cfg.marketauth to the pool
 *    PDA) and BindInsuranceAuthority MUST come AFTER it. This is the correctness
 *    trap the wizard has to get right — proven here at the tag-byte level without
 *    driving the whole wallet/RPC flow.
 */
import { describe, it, expect } from "vitest";
import {
  encodeUpdateFeeSplit,
  encodeStakeInitPool,
  encodeStakeBindInsuranceAuthority,
  IX_TAG,
  STAKE_IX,
} from "@percolatorct/sdk";
import { orderStakeTailInstructions, assetAdminBurnForCreate, FIRST_LOSS_BURN_CONSENT_COPY } from "@/hooks/useCreateMarket";

describe("UpdateFeeSplit (tag 86) wire bytes", () => {
  it("encodes tag 86 + three u16 LE shares + u64 authority epoch (15 bytes)", () => {
    const data = encodeUpdateFeeSplit({
      creatorShareBps: 2000,
      lpShareBps: 4000,
      insuranceShareBps: 2000,
      authorityEpoch: 3n,
    });
    expect(data.length).toBe(15);
    expect(data[0]).toBe(86);
    expect(IX_TAG.UpdateFeeSplit).toBe(86);
    // 2000 = 0x07D0 → LE D0 07 ; 4000 = 0x0FA0 → LE A0 0F ; 2000 = D0 07 ; epoch 3 u64 LE
    expect(Array.from(data.slice(1))).toEqual([
      0xd0, 0x07, 0xa0, 0x0f, 0xd0, 0x07,
      0x03, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("round-trips the exact WRITE-verify split (creator/LP/insurance/epoch order preserved)", () => {
    const data = encodeUpdateFeeSplit({
      creatorShareBps: 0x1111,
      lpShareBps: 0x2222,
      insuranceShareBps: 0x3333,
      authorityEpoch: 0x0807060504030201n,
    });
    // LE: 11 11 | 22 22 | 33 33 | 01..08
    expect(Array.from(data.slice(1))).toEqual([
      0x11, 0x11, 0x22, 0x22, 0x33, 0x33,
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    ]);
  });

  it("refuses to encode without the authority epoch (no silent v17 7-byte shape)", () => {
    expect(() =>
      encodeUpdateFeeSplit({ creatorShareBps: 2000, lpShareBps: 4000, insuranceShareBps: 2000 } as any),
    ).toThrow();
  });
});

describe("stake-tail sequence (orderStakeTailInstructions)", () => {
  // Tag-tagged sentinels so we can assert ordering by tag byte alone.
  const FEE_SPLIT_IX = { tag: IX_TAG.UpdateFeeSplit }; // 86
  const INIT_POOL_IX = { tag: STAKE_IX.InitPool }; // 0
  const BIND_IX = { tag: STAKE_IX.BindInsuranceAuthority }; // 19
  const PRE_A = { tag: -1 };
  const PRE_B = { tag: -2 };

  it("places UpdateFeeSplit BEFORE InitPool and Bind AFTER InitPool (non-default split)", () => {
    const out = orderStakeTailInstructions([PRE_A, PRE_B], FEE_SPLIT_IX, INIT_POOL_IX, BIND_IX);
    const feeIdx = out.indexOf(FEE_SPLIT_IX);
    const poolIdx = out.indexOf(INIT_POOL_IX);
    const bindIdx = out.indexOf(BIND_IX);
    expect(feeIdx).toBeGreaterThanOrEqual(0);
    expect(feeIdx).toBeLessThan(poolIdx); // fee split BEFORE pool init (marketauth still creator)
    expect(bindIdx).toBeGreaterThan(poolIdx); // bind AFTER pool init (pool PDA must exist)
    // full expected order
    expect(out).toEqual([PRE_A, PRE_B, FEE_SPLIT_IX, INIT_POOL_IX, BIND_IX]);
  });

  it("omits UpdateFeeSplit for a default split but still binds after InitPool", () => {
    const out = orderStakeTailInstructions([PRE_A, PRE_B], null, INIT_POOL_IX, BIND_IX);
    expect(out).toEqual([PRE_A, PRE_B, INIT_POOL_IX, BIND_IX]);
    // Bind is unconditional — the staker/insurance leg always gets its exit.
    const poolIdx = out.indexOf(INIT_POOL_IX);
    const bindIdx = out.indexOf(BIND_IX);
    expect(bindIdx).toBeGreaterThan(poolIdx);
  });

  it("BindInsuranceAuthority encodes to stake tag 19 (single byte)", () => {
    const data = encodeStakeBindInsuranceAuthority();
    expect(Array.from(data)).toEqual([19]);
    expect(STAKE_IX.BindInsuranceAuthority).toBe(19);
  });

  it("StakeInitPool encodes to stake tag 0", () => {
    const data = encodeStakeInitPool(5n, 0n);
    expect(data[0]).toBe(0);
    expect(STAKE_IX.InitPool).toBe(0);
  });
});

describe("asset-admin burn in the create bundle (L5 2026-10-22; code only, not wired to the wizard UI)", () => {
  const INIT_POOL_IX = { tag: STAKE_IX.InitPool };
  const BIND_IX = { tag: STAKE_IX.BindInsuranceAuthority };
  const BURN_IX = { tag: 21 };
  const PRE = { tag: -1 };

  it("with no burn ix the output is unchanged (default param is null)", () => {
    expect(orderStakeTailInstructions([PRE], null, INIT_POOL_IX, BIND_IX)).toEqual([PRE, INIT_POOL_IX, BIND_IX]);
  });

  it("the burn is the LAST instruction: after InitPool and after the bind (L-4: the bind is part of creation, the burn ends it)", () => {
    const out = orderStakeTailInstructions([PRE], null, INIT_POOL_IX, BIND_IX, BURN_IX);
    expect(out).toEqual([PRE, INIT_POOL_IX, BIND_IX, BURN_IX]);
    expect(out.indexOf(BURN_IX)).toBe(out.length - 1);
    expect(out.indexOf(BIND_IX)).toBeGreaterThan(out.indexOf(INIT_POOL_IX));
  });

  it("only a first-loss pool WITH the creator's acknowledgement burns; fee-only / legacy never do", () => {
    expect(assetAdminBurnForCreate("first-loss", true)).toBe(true);
    expect(assetAdminBurnForCreate("first-loss", false)).toBe(false);
    expect(assetAdminBurnForCreate("fee-only", true)).toBe(false);
    expect(assetAdminBurnForCreate("legacy", true)).toBe(false);
  });

  it("the consent copy states the three costs (fee leg, Recovery, no rotation) and irreversibility", () => {
    const t = FIRST_LOSS_BURN_CONSENT_COPY.join(" ");
    expect(t).toMatch(/cannot be undone/i);
    expect(t).toMatch(/creator fee/i);
    expect(t).toMatch(/Recovery/);
    expect(t).toMatch(/rotated/i);
  });
});
