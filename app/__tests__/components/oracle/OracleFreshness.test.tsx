/**
 * useOracleFreshness Hook Tests
 * Tests: ORACLE-004, ORACLE-005, ORACLE-006
 *
 * ORACLE-004: Returns correct freshness levels based on elapsed time
 * ORACLE-005: Detects oracle mode from config
 * ORACLE-006: Returns mode label correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

// Mock SlabProvider
const mockConfig = {
  oracleAuthority: PublicKey.default,
  indexFeedId: PublicKey.default,
  authorityPriceE6: 42000_000000n,
  authorityTimestamp: 0n,
  lastEffectivePriceE6: 42000_000000n,
  collateralMint: new PublicKey("So11111111111111111111111111111111111111112"),
};

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: mockConfig,
    slabAddress: "test-slab",
  }),
}));

import { useOracleFreshness } from "@/hooks/useOracleFreshness";

describe("useOracleFreshness", () => {
  it("ORACLE-005: detects hyperp mode when indexFeedId is zero", () => {
    // indexFeedId = PublicKey.default (all zeros) → hyperp mode
    const { result } = renderHook(() => useOracleFreshness());
    expect(result.current.mode).toBe("hyperp");
    expect(result.current.modeLabel).toBe("HYPERP");
  });

  it("ORACLE-004: returns fresh level for < 5s elapsed", () => {
    const { result } = renderHook(() => useOracleFreshness());
    // On first render with price > 0, lastUpdateMs is set to Date.now()
    // so elapsedSecs should be 0 → "fresh"
    expect(result.current.level).toBe("fresh");
    expect(result.current.color).toBe("#22c55e");
  });

  it("ORACLE-006: returns ready=true when config is available", () => {
    const { result } = renderHook(() => useOracleFreshness());
    expect(result.current.ready).toBe(true);
  });
});
