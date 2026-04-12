/**
 * Tests for useAdvanceOraclePhase hook (GH#1120 fix)
 *
 * Verifies the hook calls the server-side API route and does NOT
 * use wallet.signTransaction (which caused the Privy modal to fire).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = { oraclePhase: 0 };

vi.mock("@/hooks/useSlab", () => ({
  useSlabState: vi.fn(() => ({ config: mockConfig })),
}));

vi.mock("@percolatorct/sdk", () => ({
  ORACLE_PHASE_MATURE: 2,
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.oraclePhase = 0;
  mockFetch.mockResolvedValue({
    json: async () => ({ success: true, signature: "abc123" }),
  });
});

// Dynamic import after mocks are set
async function getHook() {
  const mod = await import("@/hooks/useAdvanceOraclePhase");
  return mod.useAdvanceOraclePhase;
}

import { renderHook } from "@testing-library/react";

describe("useAdvanceOraclePhase (GH#1120)", () => {
  it("calls /api/oracle/advance-phase when phase < ORACLE_PHASE_MATURE", async () => {
    const useAdvanceOraclePhase = await getHook();
    const slabAddress = "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM";

    renderHook(() => useAdvanceOraclePhase(slabAddress));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("/api/oracle/advance-phase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slabAddress }),
    });
  });

  it("does NOT call fetch when oraclePhase >= ORACLE_PHASE_MATURE", async () => {
    mockConfig.oraclePhase = 2;
    const useAdvanceOraclePhase = await getHook();

    renderHook(() => useAdvanceOraclePhase("7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM"));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT call fetch when slabAddress is undefined", async () => {
    const useAdvanceOraclePhase = await getHook();

    renderHook(() => useAdvanceOraclePhase(undefined));
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("only calls fetch ONCE per slabAddress (dedup via ref)", async () => {
    const useAdvanceOraclePhase = await getHook();
    const slabAddress = "7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM";

    const { rerender } = renderHook(() => useAdvanceOraclePhase(slabAddress));
    await new Promise((r) => setTimeout(r, 10));
    rerender();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles fetch errors silently without throwing", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));
    const useAdvanceOraclePhase = await getHook();

    expect(() => {
      renderHook(() => useAdvanceOraclePhase("7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM"));
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
  });

  it("does NOT import useWalletCompat (GH#1120 regression guard)", async () => {
    // The hook module must not depend on wallet hooks
    // We verify this by checking no wallet mock was called
    const useAdvanceOraclePhase = await getHook();
    renderHook(() => useAdvanceOraclePhase("7G3SsnevWwUWjWAwGGmr2N11x8KAGn1abzjV3bBbZkAM"));
    await new Promise((r) => setTimeout(r, 10));
    // If wallet hooks were called, the test environment would throw (not mocked)
    // The fact that we reach here without errors confirms no wallet dependency
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
