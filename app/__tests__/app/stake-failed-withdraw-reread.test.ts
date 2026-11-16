/**
 * #3755: a refused withdraw must re-read the position, so the retry is quoted on current data
 * instead of the stale max the refusal came from.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(path.resolve(__dirname, "../../app/stake/page.tsx"), "utf8");

function catchBlock(after: string): string {
  const i = SRC.indexOf(after);
  expect(i).toBeGreaterThan(-1);
  const c = SRC.indexOf("} catch (e) {", i);
  return SRC.slice(c, SRC.indexOf("}, [", c));
}

describe("stake withdraw refusal re-reads the position (#3755)", () => {
  it("PositionCard Withdraw All re-reads in its catch", () => {
    expect(catchBlock('const sig = await withdraw(withdrawMaxLpRaw(position));')).toContain("onWithdrawSuccess?.()");
  });
  it("the Withdraw tab bumps the refresh key in its catch", () => {
    expect(catchBlock("const sig = await withdraw(rawAmount);")).toContain("setWithdrawRefreshKey((k) => k + 1)");
  });
});
