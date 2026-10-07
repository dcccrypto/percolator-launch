import { describe, it, expect } from "vitest";
import { embeddedBatchSignOptions, isPrivyEmbeddedStandardWallet } from "@/lib/privy-batch-sign";

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
