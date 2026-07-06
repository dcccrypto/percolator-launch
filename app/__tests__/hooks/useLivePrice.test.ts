import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLivePrice } from "../../hooks/useLivePrice";

const testState = vi.hoisted(() => ({
  slabAddress: "slab-a" as string | null,
  marketByKey: {} as Record<string, any>,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(() => ({
    slabAddress: testState.slabAddress,
    config: null,
  })),
}));

vi.mock("@/lib/config", () => ({
  getBackendUrl: () => "",
}));

vi.mock("@/lib/oraclePrice", () => ({
  applyInvert: (price: bigint) => price,
  resolveMarketPriceE6: () => 0n,
  sanitizePriceE6: (price: bigint) => price,
}));

vi.mock("swr", () => ({
  default: vi.fn((key: string | null) => ({
    data: key ? testState.marketByKey[key] : undefined,
  })),
}));

describe("useLivePrice", () => {
  beforeEach(() => {
    testState.slabAddress = "slab-a";
    testState.marketByKey = {
      "/api/markets/slab-a": {
        market: {
          last_price: 42,
        },
      },
    };
  });

  it("clears previous market price when the active slab changes", async () => {
    const { result, rerender } = renderHook(() => useLivePrice());

    await waitFor(() => {
      expect(result.current.priceUsd).toBe(42);
      expect(result.current.priceE6).toBe(42_000_000n);
    });

    testState.slabAddress = "slab-b";
    testState.marketByKey = {};

    rerender();

    await waitFor(() => {
      expect(result.current.priceUsd).toBeNull();
      expect(result.current.priceE6).toBeNull();
      expect(result.current.price).toBeNull();
    });

    expect(result.current.loading).toBe(true);
  });
});
