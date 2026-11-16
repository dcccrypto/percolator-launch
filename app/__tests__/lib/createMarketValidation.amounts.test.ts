// @vitest-environment node
import { describe, it, expect } from "vitest";
import { validateCreateForm, type CreateFormValues } from "@/lib/createMarketValidation";
import { parseHumanAmount } from "@/lib/parseAmount";

function form(o: Partial<CreateFormValues> = {}): CreateFormValues {
  return {
    mint: "So11111111111111111111111111111111111111112",
    mintValid: true,
    tokenMeta: { symbol: "SOL", name: "Solana", decimals: 9 },
    oracleResolved: true,
    oracleMode: "auto",
    tradingFeeBps: 10,
    initialMarginBps: 1000,
    lpCollateral: "100",
    insuranceAmount: "10",
    tokenBalance: 400_000_000_000n,
    walletConnected: true,
    decimals: 9,
    ...o,
  };
}

/** What the wizard would send (CreateMarketWizard parseHumanAmount), or null if it throws. */
function built(s: string, decimals: number): bigint | null {
  try {
    return parseHumanAmount(s || "0", decimals);
  } catch {
    return null;
  }
}

const BAD = ["5abc", "1e400", "Infinity", "0x10", "1,000", "-0", "", "1e3", "-5", ".5.5", "1.0000000001"];
const OK = [" 12", "5.", ".5", "12"];

describe("LP / insurance amount: validator agrees with the instruction builder", () => {
  for (const field of ["lpCollateral", "insuranceAmount"] as const) {
    describe(field, () => {
      for (const v of BAD) {
        it(`${JSON.stringify(v)}: validator error unless builder sends a positive amount`, () => {
          const errors = validateCreateForm(form({ [field]: v })).filter((e) => e.severity === "error");
          const sent = built(v, 9);
          expect(errors.length).toBeGreaterThan(0);
          expect(sent === null || sent <= 0n).toBe(true);
        });
      }
      for (const v of OK) {
        it(`${JSON.stringify(v)}: accepted and builder sends the same positive amount`, () => {
          expect(validateCreateForm(form({ [field]: v })).filter((e) => e.severity === "error")).toHaveLength(0);
          const sent = built(v, 9)!;
          expect(sent > 0n).toBe(true);
          expect(Number(sent) / 1e9).toBe(parseFloat(v));
        });
      }
      it("value above the wallet balance is an error", () => {
        const errors = validateCreateForm(form({ [field]: "1000" })).filter((e) => e.severity === "error");
        expect(errors.some((e) => e.field === "Token Balance")).toBe(true);
      });
      it("valid decimals still pass", () => {
        expect(validateCreateForm(form({ [field]: "5.5" })).filter((e) => e.severity === "error")).toHaveLength(0);
      });
    });
  }
});
