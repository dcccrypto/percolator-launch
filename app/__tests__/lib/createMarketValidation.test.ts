import { describe, it, expect } from "vitest";
import {
  validateCreateForm,
  type CreateFormValues,
} from "@/lib/createMarketValidation";

function validForm(overrides: Partial<CreateFormValues> = {}): CreateFormValues {
  return {
    mint: "So11111111111111111111111111111111111111112",
    mintValid: true,
    tokenMeta: { symbol: "SOL", name: "Solana", decimals: 9 },
    oracleResolved: true,
    oracleMode: "auto",
    tradingFeeBps: 10,
    initialMarginBps: 500,
    lpCollateral: "100",
    insuranceAmount: "10",
    tokenBalance: 200_000_000_000n, // 200 SOL
    walletConnected: true,
    decimals: 9,
    ...overrides,
  };
}

describe("validateCreateForm", () => {
  it("returns no errors for valid form", () => {
    const errors = validateCreateForm(validForm());
    const actualErrors = errors.filter((e) => e.severity === "error");
    expect(actualErrors).toHaveLength(0);
  });

  // Wallet
  it("requires wallet connection", () => {
    const errors = validateCreateForm(validForm({ walletConnected: false }));
    expect(errors.some((e) => e.field === "Wallet")).toBe(true);
  });

  // Token Mint
  it("requires token mint", () => {
    const errors = validateCreateForm(validForm({ mint: "" }));
    expect(errors.some((e) => e.field === "Token Mint")).toBe(true);
  });

  it("rejects invalid mint", () => {
    const errors = validateCreateForm(
      validForm({ mint: "invalid", mintValid: false })
    );
    expect(
      errors.some(
        (e) => e.field === "Token Mint" && e.message.includes("Invalid base58")
      )
    ).toBe(true);
  });

  // Decimals overflow
  it("rejects tokens with > 12 decimals", () => {
    const errors = validateCreateForm(
      validForm({
        tokenMeta: { symbol: "X", name: "X", decimals: 18 },
      })
    );
    expect(errors.some((e) => e.field === "Token Decimals")).toBe(true);
  });

  it("accepts tokens with exactly 12 decimals", () => {
    const errors = validateCreateForm(
      validForm({
        tokenMeta: { symbol: "X", name: "X", decimals: 12 },
        decimals: 12,
      })
    );
    expect(errors.some((e) => e.field === "Token Decimals")).toBe(false);
  });

  // Oracle
  it("flags missing oracle in auto mode", () => {
    const errors = validateCreateForm(
      validForm({ oracleResolved: false, oracleMode: "auto" })
    );
    expect(
      errors.some(
        (e) => e.field === "Oracle" && e.message.includes("No oracle source")
      )
    ).toBe(true);
  });

  it("flags missing oracle in pyth mode", () => {
    const errors = validateCreateForm(
      validForm({ oracleResolved: false, oracleMode: "pyth" })
    );
    expect(
      errors.some(
        (e) => e.field === "Oracle" && e.message.includes("Pyth feed")
      )
    ).toBe(true);
  });

  it("flags missing oracle in dex mode", () => {
    const errors = validateCreateForm(
      validForm({ oracleResolved: false, oracleMode: "dex" })
    );
    expect(
      errors.some(
        (e) => e.field === "Oracle" && e.message.includes("DEX pool")
      )
    ).toBe(true);
  });

  // Trading Fee
  it("rejects 0 bps trading fee", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 0 }));
    expect(
      errors.some(
        (e) => e.field === "Trading Fee" && e.message.includes("at least 1")
      )
    ).toBe(true);
  });

  it("rejects > 100 bps trading fee", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 101 }));
    expect(
      errors.some(
        (e) => e.field === "Trading Fee" && e.message.includes("100 bps")
      )
    ).toBe(true);
  });

  // Initial Margin
  it("rejects margin < 100 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 50 }));
    expect(
      errors.some(
        (e) => e.field === "Initial Margin" && e.message.includes("at least 100")
      )
    ).toBe(true);
  });

  it("rejects margin > 5000 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 5001 }));
    expect(
      errors.some(
        (e) => e.field === "Initial Margin" && e.message.includes("5000 bps")
      )
    ).toBe(true);
  });

  // Fee vs Margin
  it("rejects fee >= margin", () => {
    const errors = validateCreateForm(
      validForm({ tradingFeeBps: 500, initialMarginBps: 500 })
    );
    expect(
      errors.some(
        (e) =>
          e.field === "Trading Fee" && e.message.includes("must be less than")
      )
    ).toBe(true);
  });

  // LP Collateral
  it("requires LP collateral", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "" }));
    expect(
      errors.some(
        (e) =>
          e.field === "LP Collateral" && e.severity === "error"
      )
    ).toBe(true);
  });

  it("rejects zero LP collateral", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "0" }));
    expect(errors.some((e) => e.field === "LP Collateral")).toBe(true);
  });

  it("warns on low LP collateral for 6-decimal token", () => {
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "5",
        decimals: 6,
        tokenMeta: { symbol: "USDC", name: "USD Coin", decimals: 6 },
        tokenBalance: 1_000_000_000n,
      })
    );
    expect(
      errors.some(
        (e) => e.field === "LP Collateral" && e.severity === "warning"
      )
    ).toBe(true);
  });

  // Insurance
  it("requires insurance amount", () => {
    const errors = validateCreateForm(validForm({ insuranceAmount: "" }));
    expect(
      errors.some(
        (e) => e.field === "Insurance Fund" && e.severity === "error"
      )
    ).toBe(true);
  });

  it("warns when insurance < 5% of LP", () => {
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "100",
        insuranceAmount: "1", // 1% < 5%
      })
    );
    expect(
      errors.some(
        (e) => e.field === "Insurance Fund" && e.severity === "warning"
      )
    ).toBe(true);
  });

  // Balance check
  it("errors on zero token balance", () => {
    const errors = validateCreateForm(validForm({ tokenBalance: 0n }));
    expect(errors.some((e) => e.field === "Token Balance")).toBe(true);
  });

  it("errors when required > balance", () => {
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "100",
        insuranceAmount: "100",
        tokenBalance: 100_000_000_000n, // 100 SOL < 200 needed
      })
    );
    expect(
      errors.some(
        (e) =>
          e.field === "Token Balance" &&
          e.severity === "error" &&
          e.message.includes("only have")
      )
    ).toBe(true);
  });

  it("warns when > 90% of balance used", () => {
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "95",
        insuranceAmount: "5",
        tokenBalance: 105_000_000_000n, // 105 SOL — 100/105 ≈ 95%
      })
    );
    expect(
      errors.some(
        (e) =>
          e.field === "Token Balance" &&
          e.severity === "warning" &&
          e.message.includes("90%")
      )
    ).toBe(true);
  });

  it("does not check balance when wallet not connected", () => {
    const errors = validateCreateForm(
      validForm({
        walletConnected: false,
        tokenBalance: 0n,
      })
    );
    // Should have wallet error but NOT token balance error
    expect(errors.some((e) => e.field === "Wallet")).toBe(true);
    expect(errors.some((e) => e.field === "Token Balance")).toBe(false);
  });

  it("skips balance check when tokenBalance is null", () => {
    const errors = validateCreateForm(validForm({ tokenBalance: null }));
    expect(errors.some((e) => e.field === "Token Balance")).toBe(false);
  });
});
