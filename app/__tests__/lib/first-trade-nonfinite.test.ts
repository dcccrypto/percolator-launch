// @vitest-environment node
/**
 * Pins what tradableMarginAtoms / fundDepositAtoms / failedFirstTradeLeg do with non-finite or
 * out-of-range inputs. No live caller passes them (OrderTicket's leverage comes from
 * nextLeverageInputState, which yields null for NaN, and clampSliderLeverage, which maps non-finite
 * to 1), so this is characterisation, not a bug fix.
 */
import { describe, expect, it } from "vitest";
import { failedFirstTradeLeg, fundDepositAtoms, tradableMarginAtoms } from "@/lib/first-trade";

const base = { inMarketAvailable: 0n, walletAtoms: 1_000_000_000n, feeBps: 10n, initialMarginBps: 1000n };
const at = (leverage100: number) => tradableMarginAtoms({ ...base, leverage100 });

describe("tradableMarginAtoms leverage100 edge inputs", () => {
  it("NaN throws RangeError (BigInt(NaN)) — unreachable from the ticket", () => {
    expect(() => at(Number.NaN)).toThrow(RangeError);
  });
  it("Infinity throws RangeError — unreachable from the ticket", () => {
    expect(() => at(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
  it("undefined (NaN after the cast) throws RangeError", () => {
    expect(() => at(undefined as unknown as number)).toThrow(RangeError);
  });
  it("0, negative and sub-1x clamp to 1x", () => {
    expect(at(0)).toBe(at(100));
    expect(at(-500)).toBe(at(100));
    expect(at(99.6)).toBe(at(100)); // rounds to 100
  });
  it("finite values are monotone non-increasing in leverage", () => {
    let prev = at(100);
    for (let l = 101; l <= 2000; l += 1.7) {
      const v = at(l);
      expect(v <= prev).toBe(true);
      prev = v;
    }
  });
});

describe("fundDepositAtoms negatives", () => {
  it("returns 0 when need <= 0", () => {
    expect(fundDepositAtoms(0n, 0n, 5_000_000n)).toBe(0n);
    expect(fundDepositAtoms(-5n, 2n, 5_000_000n)).toBe(0n);
  });
  it("returns need when the wallet is zero or negative", () => {
    expect(fundDepositAtoms(1_000_000n, 1_000n, 0n)).toBe(1_001_000n);
    expect(fundDepositAtoms(1_000_000n, 1_000n, -1n)).toBe(1_001_000n);
  });
});

describe("failedFirstTradeLeg odd inputs", () => {
  it("null / undefined / non-error values give null", () => {
    expect(failedFirstTradeLeg(null, 2)).toBeNull();
    expect(failedFirstTradeLeg(undefined, 2)).toBeNull();
    expect(failedFirstTradeLeg("boom", 2)).toBeNull();
  });
  it("parses the index from text, and a huge digit run does not crash", () => {
    expect(failedFirstTradeLeg({ message: "Error processing Instruction 2: x" }, 2)).toBe("deposit");
    expect(failedFirstTradeLeg({ message: "Error processing Instruction 3: x" }, 2)).toBe("trade");
    expect(failedFirstTradeLeg({ message: "Error processing Instruction 1: x" }, 2)).toBeNull();
    expect(failedFirstTradeLeg({ message: `Error processing Instruction ${"9".repeat(40)}` }, 2)).toBe("trade");
  });
  it("a non-numeric instructionIndex falls back to the message", () => {
    expect(failedFirstTradeLeg({ instructionIndex: "2", message: "Error processing Instruction 2" }, 2)).toBe("deposit");
  });
});
