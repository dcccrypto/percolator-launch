import { describe, it, expect } from "vitest";
import { embeddedBatchSignOptions, isPrivyEmbeddedStandardWallet, isWalletRejection } from "@/lib/privy-batch-sign";

describe("isPrivyEmbeddedStandardWallet", () => {
  it("recognises Privy's embedded wallet by isPrivyWallet or its privy: feature", () => {
    expect(isPrivyEmbeddedStandardWallet({ isPrivyWallet: true, features: {} })).toBe(true);
    expect(isPrivyEmbeddedStandardWallet({ features: { "privy:": {} } })).toBe(true);
  });

  it("does not match external wallets or missing values", () => {
    expect(isPrivyEmbeddedStandardWallet({ features: { "solana:signTransaction": {} } })).toBe(false);
    expect(isPrivyEmbeddedStandardWallet({ isPrivyWallet: false })).toBe(false);
    expect(isPrivyEmbeddedStandardWallet(undefined)).toBe(false);
    expect(isPrivyEmbeddedStandardWallet(null)).toBe(false);
  });
});

describe("embeddedBatchSignOptions", () => {
  it("keeps Privy's default modal for a single transaction", () => {
    expect(embeddedBatchSignOptions(0, 1)).toBeUndefined();
  });

  it("shows exactly one modal for an 8-tx launch batch", () => {
    const opts = Array.from({ length: 8 }, (_, i) => embeddedBatchSignOptions(i, 8));
    const shown = opts.filter((o) => o?.uiOptions.showWalletUIs !== false);
    expect(shown).toHaveLength(1);
    expect(opts[0]?.uiOptions.buttonText).toBe("Approve all 8");
    expect(opts[0]?.uiOptions.description).toContain("all 8 transactions");
  });
});

describe("isWalletRejection (the app's own wallet-rejection classification)", () => {
  const DECLINES: Array<[string, unknown]> = [
    ["User rejected the request.", new Error("User rejected the request.")],
    ["Privy: User rejected request", new Error("User rejected request")],
    ["Privy: user exited the modal", new Error("User exited the modal before submitting the transaction")],
    ["User denied transaction signature", new Error("User denied transaction signature")],
    ["Transaction cancelled", new Error("Transaction cancelled")],
    ["Transaction canceled", new Error("Transaction canceled")],
    ["Signing cancelled by user", new Error("Signing cancelled by user")],
    ["User disapproved requested methods", new Error("User disapproved requested methods")],
    ["Request declined", new Error("Request declined")],
    ["The request was rejected by the user", new Error("The request was rejected by the user")],
    ["Ledger 0x6985", new Error("Ledger device: Condition of use not satisfied (0x6985)")],
    ["Ledger statusCode", Object.assign(new Error("denied"), { statusCode: 0x6985 })],
    ["code 4001 on an Error", Object.assign(new Error(""), { code: 4001 })],
    ["code 4001 on a plain object", { code: 4001 }],
    ["string form", "WalletSignTransactionError: User rejected the request"],
  ];
  const NOT_DECLINES: Array<[string, unknown]> = [
    ["policy rejection", new Error("Transaction rejected by policy")],
    ["rate limit", new Error("429 Too Many Requests: request rejected")],
    ["bare 4001 inside another message", new Error("Custom(4001)")],
    ["bare 4001 text", new Error("program error 4001")],
    ["generic failure", new Error("rpc exploded")],
    ["locked wallet", new Error("Wallet is locked")],
    ["null", null],
    ["undefined", undefined],
  ];
  it.each(DECLINES)("declines: %s", (_n, e) => expect(isWalletRejection(e)).toBe(true));
  it.each(NOT_DECLINES)("not a decline: %s", (_n, e) => expect(isWalletRejection(e)).toBe(false));
});
