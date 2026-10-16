// @vitest-environment node
/** v2.2 QA A-3: a signed limit on v2.2 never sits on the simulated figure; the swordcat close case. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_TX_COMPUTE_UNITS, signedComputeUnitLimit, sizeComputeUnitLimit, tradeCuCap, V22_MIN_SIGNED_CU } from "@/lib/compute-budget";

const src = (f: string) => readFileSync(path.join(__dirname, "../../..", f), "utf8");

describe("A-3: signed compute-unit limit", () => {
  it("swordcat close: simulated 367,458 -> 527,696 before (landed needing > 527,222); now >= 800k on v2.2", () => {
    expect(sizeComputeUnitLimit(367_458, { cap: tradeCuCap(1) })).toBe(527_696);
    expect(signedComputeUnitLimit(367_458, { cap: tradeCuCap(1) }, true)).toBe(V22_MIN_SIGNED_CU);
    expect(signedComputeUnitLimit(367_458, { cap: tradeCuCap(1) }, true)).toBeGreaterThan(702_222); // worst measured v2.2 close
  });
  it("above the floor it is min(1.4M, ceil(sim x 1.3) + 50k); never past 1.4M; rpc failure gets the floor", () => {
    expect(signedComputeUnitLimit(700_000, { cap: tradeCuCap(1) }, true)).toBe(Math.ceil(700_000 * 1.3) + 50_000);
    expect(signedComputeUnitLimit(1_300_000, { cap: tradeCuCap(1) }, true)).toBe(MAX_TX_COMPUTE_UNITS);
    expect(signedComputeUnitLimit(null, { cap: tradeCuCap(1) }, true)).toBe(V22_MIN_SIGNED_CU);
  });
  it("flag off: unchanged", () => {
    expect(signedComputeUnitLimit(367_458, { cap: tradeCuCap(1) }, false)).toBe(527_696);
  });
  it("every simulation-sized signed limit goes through the helper (sendTx and the leg-group sender)", () => {
    expect(src("lib/tx.ts")).toContain("healedComputeUnits = signedComputeUnitLimit(g.consumed, computeUnitsFromSim);");
    expect(src("lib/tx.ts")).not.toMatch(/=\s*sizeComputeUnitLimit\(/);
    expect(src("lib/trade-leg-groups.ts")).toMatch(/units\.push\(\s*signedComputeUnitLimit\(sim\.consumed/);
  });
});
