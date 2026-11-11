/**
 * A position opened on another device (no saved entry) still gets its liquidation line on the chart (liquidation is equity-based);
 * only the ENTRY line needs a recorded entry.
 */
import { renderHook } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ADL_ONE = 1_000_000_000_000_000n;
const OWNER = new PublicKey("11111111111111111111111111111111");
const h = vi.hoisted(() => ({ pnl: 5_000_000n }));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({
    idx: 0,
    account: { owner: OWNER, positionSize: 40_000_000n, adlABasis: ADL_ONE, adlEpochSnap: 0n, pnl: h.pnl, capital: 1_000_000_000n, entryPrice: 0n },
  }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    config: { lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n },
    adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
    wrapperConfigV17: {},
    raw: new Uint8Array(8),
  }),
}));

import { usePositionLinePrices } from "@/hooks/usePositionLinePrices";
import { saveEntryPrice } from "@/lib/entry-price";

beforeEach(() => localStorage.clear());

describe("usePositionLinePrices", () => {
  it("no saved entry: liquidation line present, entry line absent", () => {
    const { result } = renderHook(() => usePositionLinePrices("SLAB"));
    expect(result.current.entry).toBeNull();
    expect(result.current.liq).not.toBeNull();
  });
  it("saved entry: both lines", () => {
    saveEntryPrice("SLAB", 0, 99_875_000n, 4, OWNER.toBase58(), 40_000_000n);
    const { result } = renderHook(() => usePositionLinePrices("SLAB"));
    expect(result.current.entry).toBeCloseTo(99.875, 3);
    expect(result.current.liq).not.toBeNull();
  });
});
