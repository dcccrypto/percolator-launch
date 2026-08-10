/**
 * PoC + regression — set-price-cap must bound maxChangeE2bps to u64 on BOTH the
 * number and string input paths.
 *
 * The route rejects `> u64max` only when maxChangeE2bps arrives as a string. On the
 * `number` path it checks only integer + non-negative, so a value like 1e21 passes
 * and is handed to encodeSetOraclePriceCap where it exceeds u64. (Admin-only, so
 * the impact is a malformed request rather than an attack — but it should 400, not
 * emit a broken instruction.)
 */
import { describe, it, expect } from "vitest";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

// Current number-path gate (route.ts): integer + non-negative only.
const currentNumberAccepts = (raw: number) => Number.isInteger(raw) && raw >= 0;
// Fixed gate: also reject anything above u64 max.
const fixedNumberAccepts = (raw: number) =>
  Number.isInteger(raw) && raw >= 0 && BigInt(raw) <= U64_MAX;

describe("set-price-cap number-path u64 bound", () => {
  it("current number path accepts a value that overflows u64 (the bug)", () => {
    expect(currentNumberAccepts(1e21)).toBe(true);     // accepted today
    expect(BigInt(1e21) > U64_MAX).toBe(true);          // ...but exceeds u64
    expect(fixedNumberAccepts(1e21)).toBe(false);       // fix rejects it
  });

  it("legitimate values still pass", () => {
    expect(fixedNumberAccepts(1_000)).toBe(true);       // default-ish
    expect(fixedNumberAccepts(0)).toBe(true);           // 0 = disabled
    // boundary: the largest safe integer is well within u64
    expect(fixedNumberAccepts(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("string path already bounded (parity target)", () => {
    const stringAccepts = (raw: string) => /^\d+$/.test(raw) && BigInt(raw) <= U64_MAX;
    expect(stringAccepts("1000000000000000000000")).toBe(false); // 1e21 as string — rejected
    expect(stringAccepts("1000")).toBe(true);
  });
});
