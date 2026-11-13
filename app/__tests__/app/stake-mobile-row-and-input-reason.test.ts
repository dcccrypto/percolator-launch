/**
 * R10 (Council r9 mobile, low): at 390px the selected /stake pool row overlaid "Deployed to insurance: $0.00" on
 * the TVL cell and hid the pool name; and a Deposit button left off by an amount like "1e3" gave no reason.
 * Source-binding for the layout (jsdom does no layout), behaviour for the message.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { depositInputMessage } from "@/lib/deposit-guard";

const SRC = fs.readFileSync(path.resolve(__dirname, "../../app/stake/page.tsx"), "utf8");

describe("pool row name cell on a narrow screen", () => {
  it("stacks the name and its notes below md, one line from md up", () => {
    const m = /data-testid="pool-name-cell"/.exec(SRC);
    expect(m).not.toBeNull();
    const line = SRC.slice(SRC.lastIndexOf("<div", m!.index), m!.index + 40);
    expect(SRC.slice(SRC.lastIndexOf("<div", m!.index), SRC.indexOf(">", m!.index))).toMatch(/flex-col[^"]*md:flex-row/);
    expect(line).toBeTruthy();
  });
  it("the notes can shrink and truncate on mobile instead of overflowing, and stay whole on desktop", () => {
    for (const id of ["pool-deployed", "pool-unclaimed"]) {
      const at = SRC.indexOf(`data-testid="${id}"`);
      const tag = SRC.slice(SRC.lastIndexOf("<span", at), at);
      expect(tag).toContain("min-w-0");
      expect(tag).toContain("truncate");
      expect(tag).toContain("md:shrink-0");
      expect(tag).not.toMatch(/(^|\s)shrink-0/);
    }
  });
});

describe("depositInputMessage", () => {
  it("explains e-notation, commas, minus and letters", () => {
    for (const v of ["1e3", "1,5", "-2", "abc", "1.2.3", "."]) {
      expect(depositInputMessage(v, 6), v).toMatch(/plain number/);
    }
  });
  it("explains too many decimals and zero", () => {
    expect(depositInputMessage("1.1234567", 6)).toBe("Use at most 6 decimal places.");
    expect(depositInputMessage("0", 6)).toBe("Enter an amount above 0.");
    expect(depositInputMessage("0.000", 6)).toBe("Enter an amount above 0.");
  });
  it("is quiet for empty and good amounts", () => {
    for (const v of ["", " ", "100", "12.5", ".5", "5."]) expect(depositInputMessage(v, 6), v).toBeNull();
  });
});

describe("Deposit button", () => {
  it("is off, with the reason shown, while the typed amount is unusable", () => {
    expect(SRC).toContain('data-testid="stake-deposit-input-error"');
    expect(SRC).toMatch(/disabled=\{amountNum <= 0 \|\| depositLoading[^}]*depositInputError !== null/);
  });
});
