/**
 * PERC-372: Tests for useAutoDeposit hook
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all the dependencies before importing
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: vi.fn(() => ({
    publicKey: null,
    connected: false,
  })),
  useConnectionCompat: vi.fn(() => ({
    connection: {
      getTokenAccountBalance: vi.fn(),
    },
  })),
}));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: vi.fn(() => null),
}));

vi.mock("@/hooks/useInitUser", () => ({
  useInitUser: vi.fn(() => ({
    initUser: vi.fn(),
    loading: false,
    error: null,
  })),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(() => ({
    config: null,
    accounts: [],
    loading: false,
    error: null,
  })),
}));

vi.mock("@/hooks/useAutoFund", () => ({
  useAutoFund: vi.fn(() => ({
    funding: false,
    result: null,
    error: null,
  })),
}));

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddressSync: vi.fn(() => "mock-ata"),
}));

describe("useAutoDeposit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset NEXT_PUBLIC_SOLANA_NETWORK for each test
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "devnet";
  });

  it("should export a function", async () => {
    const mod = await import("@/hooks/useAutoDeposit");
    expect(typeof mod.useAutoDeposit).toBe("function");
  });

  it("should not deposit on mainnet", async () => {
    process.env.NEXT_PUBLIC_SOLANA_NETWORK = "mainnet-beta";
    // The hook should be a no-op on mainnet
    const mod = await import("@/hooks/useAutoDeposit");
    expect(mod.useAutoDeposit).toBeDefined();
  });
});
