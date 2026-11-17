// @vitest-environment node
/**
 * The lenient reader dropped every character except 0-9 . , before deciding, so a negative or
 * scientific-notation amount silently became a different, positive amount ("-5" -> 5, "1e3" -> 13,
 * "0x10" -> 010) and the deposit / margin / leverage fields submitted it. Text that is not a plain
 * amount must hold no amount at all (the strict reader already refuses it).
 */
import { describe, expect, it } from "vitest";
import { decimalInputText, sanitizeDecimalInput } from "@/lib/decimal-input";
import { nextLeverageInputState } from "@/lib/leverage-control";

describe("lenient reader refuses sign / exponent / hex instead of rewriting", () => {
  it.each(["-1", "-5", "−5", "–5", "-0.5", "1e3", "1E3", "5e-1", "1e-7", "0x10", "+5e2"])(
    "%s holds no amount",
    (raw) => {
      expect(sanitizeDecimalInput(raw)).toBe("");
      expect(decimalInputText(raw)).toBe("");
    },
  );

  it("leverage field: -2 does not become 2x", () => {
    expect(nextLeverageInputState("-2", 20)).toEqual({ text: "", leverage: null });
  });

  it("still reads units, spaces and locale pasting", () => {
    expect(sanitizeDecimalInput("1 000,5 USDC")).toBe("1000.5");
    expect(sanitizeDecimalInput("12 ETH")).toBe("12");
    expect(sanitizeDecimalInput("$1,234.5")).toBe("1234.5");
    expect(sanitizeDecimalInput("0,5")).toBe("0.5");
  });
});
