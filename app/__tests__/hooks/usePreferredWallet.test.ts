import { describe, it, expect } from "vitest";
import { resolveActiveWallet } from "@/hooks/usePreferredWallet";

// Minimal wallet mock
function mockWallet(address: string, name?: string) {
  return {
    address,
    standardWallet: name ? { name } : null,
  };
}

describe("resolveActiveWallet", () => {
  it("returns null for empty wallet list", () => {
    expect(resolveActiveWallet([], null)).toBeNull();
    expect(resolveActiveWallet([], "some-address")).toBeNull();
  });

  it("returns the preferred wallet when address matches", () => {
    const wallets = [
      mockWallet("aaa111", "Phantom"),
      mockWallet("bbb222", "Backpack"),
    ];
    const result = resolveActiveWallet(wallets, "bbb222");
    expect(result?.address).toBe("bbb222");
  });

  it("falls back to default heuristic when preferred address not found", () => {
    const wallets = [
      mockWallet("aaa111", "Phantom"),
      mockWallet("bbb222", "Backpack"),
    ];
    // Preferred address doesn't match any wallet
    const result = resolveActiveWallet(wallets, "zzz999");
    // Should return first external wallet (Phantom)
    expect(result?.address).toBe("aaa111");
  });

  it("falls back to default heuristic when preferred is null", () => {
    const wallets = [
      mockWallet("embedded1", "Privy"),
      mockWallet("ext1", "Phantom"),
    ];
    const result = resolveActiveWallet(wallets, null);
    // Should prefer external (Phantom) over embedded (Privy)
    expect(result?.address).toBe("ext1");
  });

  it("default heuristic prefers external over privy embedded", () => {
    const wallets = [
      mockWallet("embedded1", "Privy"),
      mockWallet("ext1", "Phantom"),
    ];
    const result = resolveActiveWallet(wallets, null);
    expect(result?.address).toBe("ext1");
  });

  it("falls back to first wallet when all are embedded", () => {
    const wallets = [
      mockWallet("embedded1", "Privy"),
      mockWallet("embedded2", "Privy 2"),
    ];
    const result = resolveActiveWallet(wallets, null);
    expect(result?.address).toBe("embedded1");
  });

  it("returns single wallet when only one exists", () => {
    const wallets = [mockWallet("only1", "Phantom")];
    const result = resolveActiveWallet(wallets, null);
    expect(result?.address).toBe("only1");
  });

  it("preferred wallet overrides default external preference", () => {
    const wallets = [
      mockWallet("ext1", "Phantom"),
      mockWallet("embedded1", "Privy"),
    ];
    // User explicitly chose the embedded wallet
    const result = resolveActiveWallet(wallets, "embedded1");
    expect(result?.address).toBe("embedded1");
  });
});
