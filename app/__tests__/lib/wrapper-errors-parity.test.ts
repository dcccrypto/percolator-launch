/**
 * gate-100 (39b138c8): every wrapper error ordinal the app maps comes from ONE generated module,
 * pinned here to the oracle's rustc ordinals for EVERY PercolatorError variant. A shifted enum
 * then fails this test at regeneration instead of silently mis-mapping copy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { P1_ERR, P3_ERR } from "@/lib/limits/constants";

const fx = JSON.parse(readFileSync(join(process.cwd(), "__tests__/fixtures/limits/rust-p3-final.json"), "utf8")) as {
  p3Sha: string;
  allErrorsSha?: string;
  allErrors: Record<string, number>;
};
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("WRAPPER_ERR == the wrapper's PercolatorError (oracle, rustc ordinals)", () => {
  it("exactly the same names and ordinals, contiguous from 0", () => {
    expect(WRAPPER_ERR).toEqual(fx.allErrors);
    const v = Object.values(WRAPPER_ERR).sort((a, b) => a - b);
    expect(v).toEqual(v.map((_, i) => i));
    expect(read("lib/wrapper-errors.ts")).toContain((fx.allErrorsSha ?? fx.p3Sha).slice(0, 8));
  });
  it("the ordinals the gate-100 sweep asked about (4b1a5d30): nothing shifted, 87/88/89 appended", () => {
    expect(WRAPPER_ERR.EngineStale).toBe(19);
    expect(WRAPPER_ERR.EngineLockActive).toBe(21);
    expect(WRAPPER_ERR.EngineCounterUnderflow).toBe(25);
    expect(WRAPPER_ERR.LpVaultZeroSharesMinted).toBe(41);
    expect(WRAPPER_ERR.VaultLpSeniorDrawRequired).toBe(87);
    expect(WRAPPER_ERR.VaultLpRedeemNeedsRecall).toBe(88);
    expect(WRAPPER_ERR.VaultLpPausedForSeniorDraw).toBe(89);
  });
  it("7a3ac04c (matcher-inventory sync + non-bound NAV floor) appends exactly 91 LpVaultTargetPotImpaired", () => {
    expect(fx.allErrorsSha).toBe("7a3ac04c710240c1fa6be7ee7ea302b403012e4e");
    expect(WRAPPER_ERR.VaultLpBindRequiresFlatAsset).toBe(90);
    expect(WRAPPER_ERR.LpVaultTargetPotImpaired).toBe(91);
    expect(Object.keys(WRAPPER_ERR)).toHaveLength(92);
  });
  it("P1_ERR / P3_ERR are views of WRAPPER_ERR", () => {
    for (const [n, c] of Object.entries(P1_ERR)) expect(c).toBe((WRAPPER_ERR as Record<string, number>)[n]);
    for (const [n, c] of Object.entries(P3_ERR)) expect(c).toBe((WRAPPER_ERR as Record<string, number>)[n]);
  });
});

describe("no wrapper error code is a numeric literal in the mapping code", () => {
  const block = (src: string, start: string) => src.slice(src.indexOf(start), src.indexOf("\n};", src.indexOf(start)));
  it("error tables are keyed by WRAPPER_ERR names", () => {
    const em = read("lib/errorMessages.ts");
    for (const t of ["export const P1_ERROR_MESSAGES", "const ERROR_CODE_MAP"]) {
      const b = block(em, t);
      expect(b.length).toBeGreaterThan(50);
      expect(b).not.toMatch(/^\s+\d+:/m);
    }
    const pm = read("lib/parseMarketError.ts");
    for (const t of ["const STEP_ERROR_OVERRIDES", "const LAUNCH_ERROR_OVERRIDES"]) expect(block(pm, t)).not.toMatch(/^\s+\d+:/m);
    expect(block(read("lib/creatorClaimError.ts"), "const CLAIM_ERROR_MESSAGES")).not.toMatch(/^\s+\d+:/m);
    const c = read("lib/limits/constants.ts");
    for (const t of ["export const P1_ERR = {", "export const P3_ERR = {"]) {
      const b = c.slice(c.indexOf(t), c.indexOf("} as const;", c.indexOf(t)));
      expect(b).not.toMatch(/:\s*\d+,/);
    }
  });
  it("comparisons and switches use names", () => {
    expect(read("lib/earnErrors.ts")).not.toMatch(/case \d+:/);
    for (const f of ["lib/market-error.ts", "lib/errorMessages.ts", "lib/pre-resolve.ts"]) {
      expect(read(f)).not.toMatch(/code === (8|9|19|20|21|25|26|27|36|37|49|54|56|68|69)\b/);
    }
    expect(read("lib/self-heal.ts")).toMatch(/ENGINE_STALE_CODE = WRAPPER_ERR\.EngineStale/);
  });
});
