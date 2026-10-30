/**
 * rc23 prog#614/#620 (95e4345d): every permissionless TIGHTEN sets guard flag bit 2 (`GUARD_FLAG_PERM_PROVEN`) and
 * `GUARD_FLAGS_KNOWN` includes it. The vendored decoder refused any flags outside bits 0-1, so a guard that had been TIGHTENed once
 * decoded to null and the ticket closed every open on a healthy market (`guard-missing`). A mainnet build also reads an unproven guard
 * as "mint and freeze live" (`perm_for_gate`), which the app's overlay ignored (it would quote more than the program accepts: 133).
 */
import { describe, expect, it } from "vitest";
import {
  LEV_GUARD_ACCOUNT_LEN_BURST_V22, LEV_GUARD_FIELD_OFF_V22, LEV_GUARD_FLAG_V22, decodeLevGuardV22, levMergeOverlayV22,
} from "@/lib/v22/sdk";
import { LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk/layout";

function synth(flags: number): Uint8Array {
  const d = new Uint8Array(LEV_GUARD_ACCOUNT_LEN_BURST_V22);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = 17;
  d[16 + LEV_GUARD_FIELD_OFF_V22.version] = 1;
  d[16 + LEV_GUARD_FIELD_OFF_V22.flags] = flags;
  return d;
}

describe("guard flags: PERM_PROVEN (bit 2)", () => {
  it("the constant is bit 2", () => expect(LEV_GUARD_FLAG_V22.PERM_PROVEN).toBe(4));
  it("a TIGHTENed guard (flags & 4) decodes, and says so", () => {
    const g = decodeLevGuardV22(synth(4));
    expect(g.permProven).toBe(true);
    expect(g.mintAuthLive).toBe(false);
    expect(g.freezeAuthLive).toBe(false);
  });
  it("all three known bits together decode", () => {
    const g = decodeLevGuardV22(synth(7));
    expect([g.mintAuthLive, g.freezeAuthLive, g.permProven]).toEqual([true, true, true]);
  });
  it("an unknown bit (8) is still refused, like the program's validate_guard", () => {
    expect(() => decodeLevGuardV22(synth(8))).toThrow();
    expect(() => decodeLevGuardV22(synth(4 | 8))).toThrow();
  });
  it("a fresh guard has permProven false", () => expect(decodeLevGuardV22(synth(0)).permProven).toBe(false));
});

describe("levMergeOverlayV22: perm_for_gate", () => {
  const base = { repJDumpBps: 0, repMIndBps: 0, repLCapX100: 0, repNMultBps: 0, repSlot: 0n, holderDumpBps: 0, holderDumpSlot: 0n, mintAuthLive: false, freezeAuthLive: false };
  it("devnet build (proof not required): an unproven guard is not clamped", () => {
    const o = levMergeOverlayV22("Week", { ...base, permProven: false }, 1_000n, false);
    expect(o.lCapX100).not.toBe(1);
    expect(o.nMultBps).not.toBe(0);
  });
  it("mainnet build: an unproven guard clamps to authority-live (l_cap 1, n_mult 0)", () => {
    const o = levMergeOverlayV22("Week", { ...base, permProven: false }, 1_000n, true);
    expect([o.lCapX100, o.nMultBps]).toEqual([1, 0]);
  });
  it("mainnet build: once proven (and no live authority) the clamp lifts", () => {
    const o = levMergeOverlayV22("Week", { ...base, permProven: true }, 1_000n, true);
    expect(o.lCapX100).not.toBe(1);
    expect(o.nMultBps).not.toBe(0);
  });
  it("mainnet build: proven but the mint authority is live keeps the clamp", () => {
    const o = levMergeOverlayV22("Week", { ...base, permProven: true, mintAuthLive: true }, 1_000n, true);
    expect([o.lCapX100, o.nMultBps]).toEqual([1, 0]);
  });
});
