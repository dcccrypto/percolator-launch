// @vitest-environment node
/**
 * Differential: the optimised lib/limits/risk-limits must equal a frozen copy of the pre-optimisation
 * module (./frozen/risk-limits.frozen.ts) on 20k seeded random + boundary inputs.
 */
import { describe, it, expect } from "vitest";
import * as cur from "@/lib/limits/risk-limits";
import * as old from "./frozen/risk-limits.frozen";
import { MAX_OI_SIDE_Q } from "@/lib/limits/constants";

// xorshift32 — deterministic
let st = 0x9e3779b9;
const rnd = () => {
  st ^= st << 13; st >>>= 0;
  st ^= st >>> 17;
  st ^= st << 5; st >>>= 0;
  return st;
};
const U128 = (1n << 128n) - 1n;
const pick = <T,>(a: T[]): T => a[rnd() % a.length];
const big = (bits: number): bigint => {
  let v = 0n;
  for (let i = 0; i < bits; i += 32) v = (v << 32n) | BigInt(rnd());
  return v & ((1n << BigInt(bits)) - 1n);
};
const edge = [0n, 1n, 2n, 999n, 1_000_000n, MAX_OI_SIDE_Q - 1n, MAX_OI_SIDE_Q, MAX_OI_SIDE_Q + 1n, MAX_OI_SIDE_Q * 2n, U128, U128 - 1n];
const q = (): bigint => {
  const r = rnd() % 4;
  const v = r === 0 ? pick(edge) : r === 1 ? big(20) : r === 2 ? big(64) : big(100);
  return rnd() & 1 ? v : -v;
};
const uq = (): bigint => { const v = q(); return v < 0n ? -v : v; };
const sides = ["long", "short"] as const;

describe("risk-limits differential vs frozen copy", () => {
  it("sideOiHeadroomQ / sideOiAfterFill / lpTradeHeadroomQ / gates: 20k inputs, 0 mismatches", () => {
    let mismatches = 0;
    for (let n = 0; n < 20_000; n++) {
      const oiL = uq(), oiS = uq(), tk = q(), lp = q(), cap = uq();
      const side = pick([...sides]);
      const smax = rnd() % 5 === 0 ? uq() % 5000n : undefined;
      const a = cur.sideOiHeadroomQ(oiL, oiS, tk, lp, side, cap, smax);
      const b = old.sideOiHeadroomQ(oiL, oiS, tk, lp, side, cap, smax);
      const sz = q();
      const c1 = cur.sideOiAfterFill(oiL, oiS, tk, lp, sz), c2 = old.sideOiAfterFill(oiL, oiS, tk, lp, sz);
      const sg = rnd() & 1 ? 1 : -1;
      const fl = (rnd() & 1) === 0;
      const eq = [
        a === b,
        c1.long === c2.long && c1.short === c2.short,
        cur.lpTradeHeadroomQ(lp, side, cap, fl) === old.lpTradeHeadroomQ(lp, side, cap, fl),
        cur.lpFillHeadroomQ(lp, sg, cap) === old.lpFillHeadroomQ(lp, sg, cap),
        cur.lpFillGate(tk, tk, lp, sz, cap, fl) === old.lpFillGate(tk, tk, lp, sz, cap, fl),
        cur.positionChangeReduceOnly(lp, sz) === old.positionChangeReduceOnly(lp, sz),
        cur.sameOwnerRoomQ(tk, side) === old.sameOwnerRoomQ(tk, side),
        cur.execPriceWithinBand(uq(), cap, Number(rnd() % 20000)) !== undefined,
      ];
      if (eq.includes(false)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it("maxTradeSizePerSide: 20k random SizeLimitInputs, 0 mismatches", () => {
    let mismatches = 0;
    for (let n = 0; n < 20_000; n++) {
      const i: cur.SizeLimitInputs = {
        priceE6: rnd() % 10 === 0 ? 0n : big(36) + 1n,
        initialMarginBps: rnd() % 10 === 0 ? 0n : BigInt(rnd() % 20_000),
        oiEffLongQ: uq(),
        oiEffShortQ: uq(),
        limits: { sideOiCapQ: rnd() & 1 ? 0n : uq(), lpFloorAtoms: rnd() & 1 ? 0n : uq(), lpExposureKBps: rnd() % 3 === 0 ? 0 : rnd() % 3_000_000 },
        lp: rnd() % 6 === 0 ? null : { posQ: q(), capital: uq(), pnl: q(), feeCredits: q() },
        takerPosQ: q(),
        matcher: rnd() % 4 === 0 ? null : {
          maxFillAbs: rnd() & 1 ? 0n : uq(),
          maxInventoryAbs: rnd() & 1 ? 0n : uq(),
          inventoryBase: rnd() % 5 === 0 ? null : q(),
          lpRealQ: rnd() % 3 === 0 ? undefined : rnd() % 3 === 1 ? null : q(),
          syncLive: rnd() & 1 ? true : undefined,
        },
        vaultLp: rnd() % 3 === 0 ? { levBps: rnd() % 50_000 } : rnd() % 2 ? null : undefined,
      };
      const a = cur.maxTradeSizePerSide(i), b = old.maxTradeSizePerSide(i);
      if (JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}n` : v)) !== JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}n` : v))) mismatches++;
      const r1 = cur.lpRiskState(i), r2 = old.lpRiskState(i);
      if (JSON.stringify(r1, (_, v) => (typeof v === "bigint" ? `${v}n` : v)) !== JSON.stringify(r2, (_, v) => (typeof v === "bigint" ? `${v}n` : v))) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});
