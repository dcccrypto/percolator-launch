import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LOT_SURFACES, allLotSurfacesCovered, lotTradingRefusal, uncoveredLotSurfaces } from "@/lib/v22/lot-coverage";

afterEach(() => __setDevnetV22ForTest(null));

describe("lot coverage registry", () => {
  it("every covered surface names a test file that exists and contains its evidence", () => {
    for (const [id, s] of Object.entries(LOT_SURFACES)) {
      if (!s.covered) continue;
      expect(s.test, id).toBeTruthy();
      const file = path.join(process.cwd(), s.test!);
      expect(fs.existsSync(file), `${id}: ${s.test}`).toBe(true);
      expect(fs.readFileSync(file, "utf8"), `${id}: evidence`).toContain(s.evidence!);
    }
  });
  it("surfaces that depend on other repos stay uncovered, so lot markets stay refused", () => {
    expect(uncoveredLotSurfaces()).toEqual(expect.arrayContaining(["keeper-mark-scaling", "indexer-candles-trades", "trade-stats-panel"]));
    expect(allLotSurfacesCovered()).toBe(false);
  });
  it("the guard: flag off allows; unknown exponent refuses; lotExp 0 allows; lotExp > 0 refuses while any surface is uncovered", () => {
    expect(lotTradingRefusal(3, false)).toBeNull();
    expect(lotTradingRefusal(null, true)).toMatch(/Try again in a moment/);
    expect(lotTradingRefusal(0, true)).toBeNull();
    expect(lotTradingRefusal(3, true)).toBe("Trading this market isn't available in the app yet.");
  });
  it("the guard is the AND of the registry: all covered allows lots, one uncovered refuses again", () => {
    const all = { a: { covered: true }, b: { covered: true } };
    expect(lotTradingRefusal(3, true, all)).toBeNull();
    expect(lotTradingRefusal(3, true, { ...all, c: { covered: false } })).not.toBeNull();
    expect(lotTradingRefusal(3, true, {})).not.toBeNull(); // an empty registry covers nothing
  });
});
