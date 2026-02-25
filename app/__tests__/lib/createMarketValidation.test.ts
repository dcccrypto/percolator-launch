import { describe, it, expect } from "vitest";
import { validateCreateForm, type CreateFormValues } from "../../lib/createMarketValidation";

/** Helper: returns a valid baseline form to mutate for individual tests */
function validForm(overrides: Partial<CreateFormValues> = {}): CreateFormValues {
  return {
    mint: "So11111111111111111111111111111111111111112",
    mintValid: true,
    tokenMeta: { symbol: "SOL", name: "Solana", decimals: 9 },
    oracleResolved: true,
    oracleMode: "auto",
    tradingFeeBps: 30,
    initialMarginBps: 500,
    lpCollateral: "100",
    insuranceAmount: "10",
    tokenBalance: 1_000_000_000_000n, // 1000 SOL
    walletConnected: true,
    decimals: 9,
    ...overrides,
  };
}

function fieldErrors(errors: ReturnType<typeof validateCreateForm>, field: string) {
  return errors.filter((e) => e.field === field);
}

describe("validateCreateForm", () => {
  // ── Happy path ──
  it("returns no errors for a fully valid form", () => {
    expect(validateCreateForm(validForm())).toEqual([]);
  });

  // ── Wallet ──
  it("errors when wallet is not connected", () => {
    const errors = validateCreateForm(validForm({ walletConnected: false }));
    expect(fieldErrors(errors, "Wallet")).toHaveLength(1);
    expect(fieldErrors(errors, "Wallet")[0].severity).toBe("error");
  });

  // ── Token Mint ──
  it("errors when mint is empty", () => {
    const errors = validateCreateForm(validForm({ mint: "" }));
    expect(fieldErrors(errors, "Token Mint")).toHaveLength(1);
  });

  it("errors when mint is invalid", () => {
    const errors = validateCreateForm(validForm({ mint: "invalidkey", mintValid: false }));
    expect(fieldErrors(errors, "Token Mint")).toHaveLength(1);
    expect(fieldErrors(errors, "Token Mint")[0].message).toContain("Invalid base58");
  });

  // ── Token Decimals overflow ──
  it("errors when token decimals exceed max (12)", () => {
    const errors = validateCreateForm(
      validForm({ tokenMeta: { symbol: "X", name: "X", decimals: 18 } })
    );
    expect(fieldErrors(errors, "Token Decimals")).toHaveLength(1);
    expect(fieldErrors(errors, "Token Decimals")[0].message).toContain("overflow");
  });

  it("allows tokens with exactly 12 decimals", () => {
    const errors = validateCreateForm(
      validForm({ tokenMeta: { symbol: "X", name: "X", decimals: 12 } })
    );
    expect(fieldErrors(errors, "Token Decimals")).toHaveLength(0);
  });

  // ── Oracle ──
  it("errors when oracle not resolved in auto mode", () => {
    const errors = validateCreateForm(validForm({ oracleResolved: false, oracleMode: "auto" }));
    expect(fieldErrors(errors, "Oracle")).toHaveLength(1);
    expect(fieldErrors(errors, "Oracle")[0].message).toContain("DEX Pool or Pyth");
  });

  it("errors when oracle not resolved in pyth mode", () => {
    const errors = validateCreateForm(validForm({ oracleResolved: false, oracleMode: "pyth" }));
    expect(fieldErrors(errors, "Oracle")).toHaveLength(1);
    expect(fieldErrors(errors, "Oracle")[0].message).toContain("Pyth feed ID");
  });

  it("errors when oracle not resolved in dex mode", () => {
    const errors = validateCreateForm(validForm({ oracleResolved: false, oracleMode: "dex" }));
    expect(fieldErrors(errors, "Oracle")).toHaveLength(1);
    expect(fieldErrors(errors, "Oracle")[0].message).toContain("DEX pool address");
  });

  it("skips oracle check if mint is empty", () => {
    const errors = validateCreateForm(validForm({ mint: "", oracleResolved: false }));
    expect(fieldErrors(errors, "Oracle")).toHaveLength(0);
  });

  it("skips oracle check if mint is invalid", () => {
    const errors = validateCreateForm(validForm({ mintValid: false, oracleResolved: false }));
    expect(fieldErrors(errors, "Oracle")).toHaveLength(0);
  });

  // ── Trading Fee ──
  it("errors when trading fee is 0 bps", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 0 }));
    expect(fieldErrors(errors, "Trading Fee").some((e) => e.message.includes("at least 1 bps"))).toBe(true);
  });

  it("errors when trading fee exceeds 100 bps", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 101 }));
    expect(fieldErrors(errors, "Trading Fee").some((e) => e.message.includes("100 bps or less"))).toBe(true);
  });

  it("accepts trading fee of exactly 1 bps", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 1 }));
    expect(fieldErrors(errors, "Trading Fee")).toHaveLength(0);
  });

  it("accepts trading fee of exactly 100 bps", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 100, initialMarginBps: 5000 }));
    expect(fieldErrors(errors, "Trading Fee")).toHaveLength(0);
  });

  // ── Initial Margin ──
  it("errors when margin below 100 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 99 }));
    expect(fieldErrors(errors, "Initial Margin").some((e) => e.message.includes("at least 100 bps"))).toBe(true);
  });

  it("errors when margin above 5000 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 5001 }));
    expect(fieldErrors(errors, "Initial Margin").some((e) => e.message.includes("5000 bps or less"))).toBe(true);
  });

  it("accepts margin of exactly 100 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 100, tradingFeeBps: 10 }));
    expect(fieldErrors(errors, "Initial Margin")).toHaveLength(0);
  });

  it("accepts margin of exactly 5000 bps", () => {
    const errors = validateCreateForm(validForm({ initialMarginBps: 5000 }));
    expect(fieldErrors(errors, "Initial Margin")).toHaveLength(0);
  });

  // ── Fee vs Margin ──
  it("errors when fee equals margin (would consume entire margin)", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 100, initialMarginBps: 100 }));
    expect(fieldErrors(errors, "Trading Fee").some((e) => e.message.includes("consume the entire margin"))).toBe(true);
  });

  it("errors when fee exceeds margin", () => {
    const errors = validateCreateForm(validForm({ tradingFeeBps: 100, initialMarginBps: 50 }));
    // Should get both the margin-too-low error and the fee-vs-margin error
    const feeErrors = fieldErrors(errors, "Trading Fee");
    expect(feeErrors.length).toBeGreaterThanOrEqual(1);
  });

  // ── LP Collateral ──
  it("errors when LP collateral is empty", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "" }));
    expect(fieldErrors(errors, "LP Collateral")).toHaveLength(1);
  });

  it("errors when LP collateral is 0", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "0" }));
    expect(fieldErrors(errors, "LP Collateral")).toHaveLength(1);
  });

  it("errors when LP collateral is NaN", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "abc" }));
    expect(fieldErrors(errors, "LP Collateral")).toHaveLength(1);
  });

  it("warns when LP collateral below minimum for 6-decimal tokens", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "5", decimals: 6 }));
    const lpWarnings = fieldErrors(errors, "LP Collateral").filter((e) => e.severity === "warning");
    expect(lpWarnings).toHaveLength(1);
    expect(lpWarnings[0].message).toContain("10 tokens");
  });

  it("warns when LP collateral below minimum for 9-decimal tokens", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "0.005", decimals: 9 }));
    const lpWarnings = fieldErrors(errors, "LP Collateral").filter((e) => e.severity === "warning");
    expect(lpWarnings).toHaveLength(1);
    expect(lpWarnings[0].message).toContain("0.01 tokens");
  });

  it("defaults to 1 token minimum for unknown decimal values", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "0.5", decimals: 8 }));
    const lpWarnings = fieldErrors(errors, "LP Collateral").filter((e) => e.severity === "warning");
    expect(lpWarnings).toHaveLength(1);
    expect(lpWarnings[0].message).toContain("1 tokens");
  });

  // ── Insurance Fund ──
  it("errors when insurance amount is empty", () => {
    const errors = validateCreateForm(validForm({ insuranceAmount: "" }));
    expect(fieldErrors(errors, "Insurance Fund")).toHaveLength(1);
  });

  it("errors when insurance amount is 0", () => {
    const errors = validateCreateForm(validForm({ insuranceAmount: "0" }));
    expect(fieldErrors(errors, "Insurance Fund")).toHaveLength(1);
  });

  it("warns when insurance is below 5% of LP collateral", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "100", insuranceAmount: "2" }));
    const insWarnings = fieldErrors(errors, "Insurance Fund").filter((e) => e.severity === "warning");
    expect(insWarnings).toHaveLength(1);
    expect(insWarnings[0].message).toContain("5%");
  });

  it("no warning when insurance is exactly 5% of LP collateral", () => {
    const errors = validateCreateForm(validForm({ lpCollateral: "100", insuranceAmount: "5" }));
    const insWarnings = fieldErrors(errors, "Insurance Fund").filter((e) => e.severity === "warning");
    expect(insWarnings).toHaveLength(0);
  });

  // ── Token Balance ──
  it("errors when balance is zero", () => {
    const errors = validateCreateForm(validForm({ tokenBalance: 0n }));
    expect(fieldErrors(errors, "Token Balance")).toHaveLength(1);
    expect(fieldErrors(errors, "Token Balance")[0].message).toContain("no tokens");
  });

  it("errors when combined LP + insurance exceeds balance", () => {
    // 100 + 10 = 110 tokens needed, balance = 100 tokens (100 * 10^9 native)
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "100",
        insuranceAmount: "10",
        tokenBalance: 100_000_000_000n, // 100 tokens with 9 decimals
        decimals: 9,
      })
    );
    expect(fieldErrors(errors, "Token Balance").some((e) => e.severity === "error")).toBe(true);
  });

  it("warns when combined LP + insurance exceeds 90% of balance", () => {
    // 90 + 5 = 95 tokens needed, balance = 100 tokens
    const errors = validateCreateForm(
      validForm({
        lpCollateral: "90",
        insuranceAmount: "5",
        tokenBalance: 100_000_000_000n, // 100 tokens with 9 decimals
        decimals: 9,
      })
    );
    expect(fieldErrors(errors, "Token Balance").some((e) => e.severity === "warning")).toBe(true);
  });

  it("skips balance check when wallet not connected", () => {
    const errors = validateCreateForm(
      validForm({ walletConnected: false, tokenBalance: 0n })
    );
    // Should get wallet error but not balance error
    expect(fieldErrors(errors, "Token Balance")).toHaveLength(0);
  });

  it("skips balance check when tokenBalance is null", () => {
    const errors = validateCreateForm(validForm({ tokenBalance: null }));
    expect(fieldErrors(errors, "Token Balance")).toHaveLength(0);
  });

  it("skips balance check when mint is invalid", () => {
    const errors = validateCreateForm(validForm({ mintValid: false, tokenBalance: 0n }));
    expect(fieldErrors(errors, "Token Balance")).toHaveLength(0);
  });

  // ── Multiple errors ──
  it("returns multiple errors for a completely invalid form", () => {
    const errors = validateCreateForm({
      mint: "",
      mintValid: false,
      tokenMeta: null,
      oracleResolved: false,
      oracleMode: "auto",
      tradingFeeBps: 0,
      initialMarginBps: 0,
      lpCollateral: "",
      insuranceAmount: "",
      tokenBalance: null,
      walletConnected: false,
      decimals: 6,
    });
    // Should have errors for wallet, mint, fee, margin, LP, insurance (not oracle since mint is empty)
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });
});
