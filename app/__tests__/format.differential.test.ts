import { describe, it, expect } from "vitest";
import * as cur from "@/lib/format";
import * as old from "./fixtures/format.frozen";

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 12_000;
const r = rng(0xf0a7);

function genBig(): bigint | null {
  const k = Math.floor(r() * 12);
  if (k === 0) return null;
  const digits = 1 + Math.floor(r() * 24);
  let s = "";
  for (let i = 0; i < digits; i++) s += Math.floor(r() * 10);
  let v = BigInt(s);
  if (k === 1) v = 0n;
  if (k === 2) v = cur.LIQ_PRICE_UNLIQUIDATABLE;
  if (k === 3) v = 1_000_000_000_000n + BigInt(Math.floor(r() * 3) - 1);
  return r() < 0.25 ? -v : v;
}

function genNum(): number | null {
  const k = Math.floor(r() * 14);
  if (k === 0) return null;
  if (k === 1) return [NaN, Infinity, -Infinity, 0, -0, 1, 1000, 999.99995, 0.0001, 1e-9, 1e21][Math.floor(r() * 11)];
  const mag = Math.pow(10, Math.floor(r() * 16) - 9);
  const v = r() * mag;
  return r() < 0.15 ? -v : v;
}

const bigs = Array.from({ length: N }, genBig);
const nums = Array.from({ length: N }, genNum);
const decs = Array.from({ length: N }, () => [0, 1, 6, 9, 18, 2.7, -1, NaN][Math.floor(r() * 8)]);

describe("format.ts differential vs frozen pre-optimisation copy", () => {
  it("formatUsd", () => {
    for (const x of bigs) expect(cur.formatUsd(x)).toBe(old.formatUsd(x));
  });
  it("formatLiqPrice", () => {
    for (let i = 0; i < N; i++) {
      const o = i % 2 ? { hasPosition: true } : undefined;
      expect(cur.formatLiqPrice(bigs[i], o)).toBe(old.formatLiqPrice(bigs[i], o));
    }
  });
  it("formatUsdPriceE6", () => {
    for (const x of bigs) expect(cur.formatUsdPriceE6(x)).toBe(old.formatUsdPriceE6(x));
  });
  it("formatSpreadUsd", () => {
    for (const x of bigs) if (x != null) expect(cur.formatSpreadUsd(x)).toBe(old.formatSpreadUsd(x));
  });
  it("formatMarkPrice", () => {
    for (const x of nums) expect(cur.formatMarkPrice(x)).toBe(old.formatMarkPrice(x));
  });
  it("formatUsdFromNumber", () => {
    for (const x of nums) expect(cur.formatUsdFromNumber(x)).toBe(old.formatUsdFromNumber(x));
  });
  it("formatTokenAmount / formatPnl", () => {
    for (let i = 0; i < N; i++) {
      expect(cur.formatTokenAmount(bigs[i], decs[i])).toBe(old.formatTokenAmount(bigs[i], decs[i]));
      expect(cur.formatTokenAmount(bigs[i], decs[i], 2)).toBe(old.formatTokenAmount(bigs[i], decs[i], 2));
      expect(cur.formatPnl(bigs[i], decs[i])).toBe(old.formatPnl(bigs[i], decs[i]));
    }
  });
});
