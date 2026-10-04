/**
 * The close ticket's cap-clamp explanation (lib/marketCapacity.ts closeCapacityMessage).
 *
 * Live case pinned (TROLL gWwfjop…, 2026-10-03, read from devnet): the LP (77zWreuC…) is SHORT
 * 20,903,010,033 q, exactly its matcher max_inventory_abs 20,903,010,033 (one user long
 * 26,128,254,817; the reporter short 5,225,244,784). Closing the short is a user BUY, the LP sells
 * and would go further short, so the matcher fills 0. A simulated TradeCpi close returned success
 * with the position UNCHANGED (zero fill) at 1%, 50% and 100%. The block is real; the copy was not:
 * it offered "close up to 0% now".
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { closeCapacityMessage, remainingSideCapacityQ, wouldExceedInventoryCap } from "@/lib/marketCapacity";

const TROLL_INV = -20_903_010_033n;
const TROLL_MAX_INV = 20_903_010_033n;
const TROLL_SHORT = 5_225_244_784n;

describe("closeCapacityMessage", () => {
  it("TROLL: a short's close (user buys) has zero room at every slider value", () => {
    expect(remainingSideCapacityQ(TROLL_INV, TROLL_MAX_INV, "long")).toBe(0n);
    for (const pct of [1n, 25n, 50n, 100n]) {
      expect(wouldExceedInventoryCap(TROLL_INV, TROLL_MAX_INV, "long", (TROLL_SHORT * pct) / 100n)).toBe(true);
    }
    // ...while the opposite direction (a long's close, a user sell) has twice the cap.
    expect(remainingSideCapacityQ(TROLL_INV, TROLL_MAX_INV, "short")).toBe(2n * TROLL_MAX_INV);
  });

  it("zero room: says it cannot close now, never 'close up to 0%'", () => {
    const m = closeCapacityMessage(0n, TROLL_SHORT);
    expect(m).toMatch(/can't be closed through the market right now/);
    expect(m).not.toMatch(/0%/);
    expect(closeCapacityMessage(-5n, TROLL_SHORT)).toBe(m);
    // Room under 1% of the position rounds to the same honest message.
    expect(closeCapacityMessage(TROLL_SHORT / 200n, TROLL_SHORT)).toBe(m);
  });

  it("offers a percent of the WHOLE position (the slider's unit), not of this close's size", () => {
    // 1000 position, 200 of room. Choosing 50% (500) used to say 40% (200/500); a 40% retry = 400 > 200.
    const m = closeCapacityMessage(200n, 1000n);
    expect(m).toMatch(/Close up to 20% now/);
    expect(m).toMatch(/can take 20% of your position/);
    // and the offered percent really does fit
    expect(wouldExceedInventoryCap(0n, 200n, "short", (1000n * 20n) / 100n)).toBe(false);
  });

  it("the close hook builds its message from the whole position and rethrows it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../hooks/useClosePosition.ts"), "utf8");
    expect(src).toMatch(/throw new UserFacingError\(closeCapacityMessage\(capacity, freshAbs\)\)/);
    expect(src).toMatch(/if \(capErr instanceof UserFacingError\) \{\s*throw capErr;/);
    expect(src).not.toMatch(/capacity \* 100n\) \/ sizeAbs/);
  });
});
