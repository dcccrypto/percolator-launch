/**
 * N27: every amount / size / leverage field stripped a decimal comma, so on a comma-locale phone
 * (inputMode="decimal" shows a "," key) "0,5" became "05" = 5, "2,5"x became 25x and "1,5" USDC
 * became 15; Earn refused the comma keystroke, so "10,5" ended as "105". One shared sanitiser now
 * reads a decimal comma as a point, keeping the launch dial's thousands rule for pasted values.
 */
import { describe, expect, it } from "vitest";
import { decimalInputText, sanitizeDecimalInput } from "@/lib/decimal-input";
import { nextLeverageInputState } from "@/lib/leverage-control";

/** What a field holds after the user types `keys` one at a time. */
const typed = (keys: string) => [...keys].reduce((v, k) => sanitizeDecimalInput(v + k), "");

describe("sanitizeDecimalInput", () => {
  it("a decimal comma typed key by key is a decimal point", () => {
    expect(typed("0,5")).toBe("0.5");
    expect(typed("1,5")).toBe("1.5");
    expect(typed("10,5")).toBe("10.5");
    expect(typed("1,5,")).toBe("1.5"); // a second separator is dropped, as a second point was
  });

  it("pasted values keep the thousands rule", () => {
    expect(sanitizeDecimalInput("1,000")).toBe("1000");
    expect(sanitizeDecimalInput("12,345,678")).toBe("12345678");
    expect(sanitizeDecimalInput("1,000.50")).toBe("1000.50");
    expect(sanitizeDecimalInput("0,25")).toBe("0.25");
  });

  it("a pasted value that is not a grouped number is a decimal comma, never 1000x larger", () => {
    expect(sanitizeDecimalInput("0,500")).toBe("0.500"); // was "0500" = 500
    expect(sanitizeDecimalInput("12345,678")).toBe("12345.678");
    expect(sanitizeDecimalInput("2,500")).toBe("2500"); // a grouped number: still thousands
  });

  it("CONTROL (unchanged): digits, one point, everything else stripped", () => {
    expect(sanitizeDecimalInput("1.5")).toBe("1.5");
    expect(sanitizeDecimalInput("1.2.3")).toBe("1.23");
    expect(sanitizeDecimalInput("$12a")).toBe("12");
    expect(sanitizeDecimalInput("")).toBe("");
  });
});

/**
 * What a field wired through useDecimalInput shows and holds after the user types `keys` one at a
 * time: the shown text keeps the user's comma, the held value is the canonical dot form.
 */
const typedField = (keys: string) => {
  const text = [...keys].reduce((t, k) => decimalInputText(t + k), "");
  return { text, value: sanitizeDecimalInput(text) };
};

describe("thousands commas are never read as a decimal point (follow-up to N27)", () => {
  it("typing 1,000 key by key is one thousand, not 1", () => {
    expect(typedField("1,000")).toEqual({ text: "1,000", value: "1000" });
  });

  it("every intermediate state of 1,000 keeps the comma, so the next key can still make it 1000", () => {
    expect(typedField("1,")).toEqual({ text: "1,", value: "1." });
    expect(typedField("1,0")).toEqual({ text: "1,0", value: "1.0" });
    expect(typedField("1,00")).toEqual({ text: "1,00", value: "1.00" });
    expect(typedField("1,000")).toEqual({ text: "1,000", value: "1000" });
  });

  it("typing 1,000,000 key by key is one million", () => {
    expect(typedField("1,000,000").value).toBe("1000000");
    expect(typedField("1,000,0").value).toBe("10000"); // mid-typing: a second comma proves grouping
    expect(typedField("12,345,678").value).toBe("12345678");
  });

  it("a decimal comma typed key by key is still a decimal (the PR's intent)", () => {
    expect(typedField("0,5")).toEqual({ text: "0,5", value: "0.5" });
    expect(typedField("2,5").value).toBe("2.5");
    expect(typedField("12,75")).toEqual({ text: "12,75", value: "12.75" });
    expect(typedField("1,0005").value).toBe("1.0005"); // more than 3 digits: decimal
    expect(typedField("0,000").value).toBe("0.000"); // no group starts with 0
    expect(typedField("1,5,").value).toBe("1.5"); // a stray second comma is dropped, never 15
  });

  it("a point typed key by key is unchanged", () => {
    expect(typedField("1.5")).toEqual({ text: "1.5", value: "1.5" });
    expect(typedField("1.2.3").value).toBe("1.23");
  });

  it("pasted mixed grouping: the LAST separator is the decimal one", () => {
    expect(sanitizeDecimalInput("1,234.5")).toBe("1234.5");
    expect(sanitizeDecimalInput("1.000,50")).toBe("1000.50");
    expect(sanitizeDecimalInput("1.234.567,89")).toBe("1234567.89");
    expect(sanitizeDecimalInput("1,234,567.89")).toBe("1234567.89");
  });

  it("a pasted dot-grouped whole number keeps its thousands", () => {
    expect(sanitizeDecimalInput("1.000.000")).toBe("1000000");
  });

  it("the canonical value is a fixed point (fields that re-sanitise it see no change)", () => {
    for (const v of ["1.", "1.5", "1000", "0.500", "1000.50", "12.75", ""]) expect(sanitizeDecimalInput(v)).toBe(v);
  });
});

describe("the leverage field reads 2,5 as 2.5x, not 25x", () => {
  it("typed key by key", () => {
    let text = "";
    let leverage: number | null = null;
    for (const ch of "2,5") ({ text, leverage } = nextLeverageInputState(text + ch, 20));
    expect(text).toBe("2.5");
    expect(leverage).toBe(2.5);
  });
});
