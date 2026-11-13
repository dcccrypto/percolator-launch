// @vitest-environment node
/**
 * Council 2026-11-07 council-leftovers run 2, findings 4, 5 and 13 (Skeptic, Attacker, First-timer, Trader, LP):
 *  - the strict Earn parser still REWROTE malformed separators with Deposit enabled:
 *      1.2.3 → 1.23, 1..5 → 1.5, 1,2,3 → 1.23, 1,000.5.5 → 1.00055, 1,000,00 → 100000;
 *  - comma ambiguity on a money field ("1,5" = 1.5 but "1,500" = 1500) with no echo of the amount read;
 *  - "5e-1" / "1e-3" / "1e-7" got the "negative" reason: the exponent check must come first.
 * `strictDecimalReading` refuses those shapes (no amount) and names the amount it read, with the other reading
 * spelled out when the text is the one ambiguous shape.
 */
import { describe, expect, it } from "vitest";
import { decimalInputRejection, strictDecimalReading } from "../../lib/decimal-input";

const NNBSP = " ";

describe("strict amount: repeated or misplaced separators are refused, not rewritten", () => {
  it.each(["1.2.3", "1..5", "1,2,3", "1,000.5.5", "1,000,00", "1,000,0", "1,000,", "1.000.000", "1,5.", "1.5,", "1.000,5.0", ",,5", "1,,000", "12,34,567"])(
    "%s holds no amount and says why",
    (raw) => {
      const r = strictDecimalReading(raw);
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/decimal point|comma/i);
      expect(decimalInputRejection(raw), raw).not.toBeNull();
    },
  );

  it.each([
    ["5", "5"],
    ["0.5", "0.5"],
    [".5", ".5"],
    ["5.", "5."],
    ["1,5", "1.5"],
    ["0,5", "0.5"],
    ["12,75", "12.75"],
    ["1,000", "1000"],
    ["1,500", "1500"],
    ["12,345,678", "12345678"],
    ["1,234.56", "1234.56"],
    ["1.000,50", "1000.50"],
    ["1.234.567,8", "1234567.8"],
    [" 25 ", "25"],
    ["", ""],
  ])("%s reads as %s", (raw, value) => {
    const r = strictDecimalReading(raw);
    expect(r.ok, raw).toBe(true);
    if (r.ok) expect(r.value).toBe(value);
  });
});

describe("strict amount: the exponent check comes before the minus check", () => {
  it.each(["5e-1", "1e-3", "1e-7", "-1e3", "1E+3", "1e3"])("%s gets the full-number reason, not 'negative'", (raw) => {
    expect(decimalInputRejection(raw)).toMatch(/full number/i);
  });
  it("a plain negative still gets the negative reason", () => {
    expect(decimalInputRejection("-5")).toMatch(/negative/i);
    expect(decimalInputRejection("−0.5")).toMatch(/negative/i);
  });
});

describe("strict amount: the amount read is echoed whenever a comma is involved", () => {
  it("no echo for a plain dot amount", () => {
    const r = strictDecimalReading("1500.5");
    expect(r.ok && r.echo).toBeNull();
  });
  it("a decimal comma echoes the dot reading", () => {
    const r = strictDecimalReading("1,5");
    expect(r.ok && r.echo).toEqual({ amount: "1.5", alternative: null });
  });
  it("the ambiguous shape 1-3 digits , 3 digits echoes the grouping reading AND names the other one", () => {
    expect(strictDecimalReading("1,500")).toMatchObject({ ok: true, value: "1500", echo: { amount: "1500", alternative: "1.5" } });
    expect(strictDecimalReading("2,250")).toMatchObject({ echo: { amount: "2250", alternative: "2.25" } });
    expect(strictDecimalReading("1,000")).toMatchObject({ echo: { amount: "1000", alternative: "1" } });
  });
  it("large grouped numbers are echoed with thin spaces (unambiguous in every locale)", () => {
    expect(strictDecimalReading("12,345,678.5")).toMatchObject({ echo: { amount: `12${NNBSP}345${NNBSP}678.5`, alternative: null } });
    expect(strictDecimalReading("1.000,50")).toMatchObject({ echo: { amount: "1000.50", alternative: null } });
  });
});
