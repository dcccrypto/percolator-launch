/**
 * #3726: the hook the two close wrappers (ClosePositionModal, OrderTicketClosePanel) use. It reads the market of the surrounding
 * SlabProvider and estimates a close as the opposite-side order of the closed size.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_ON, marketLimits } from "../lib/limits/fixtures";

const mocks = vi.hoisted(() => ({ limits: null as unknown, mock: false, readFor: [] as unknown[] }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ slabAddress: "SLAB1111111111111111111111111111111111111111" }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: (slab: unknown) => { mocks.readFor.push(slab); return mocks.limits; } }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: null }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => mocks.mock }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => true }));

import { closeOrderInput, useCloseFeeEstimate } from "@/hooks/useCloseFeeEstimate";

const USD = 1_000_000n;
const base0 = marketLimits();
const charged = marketLimits({
  matcher: { ...base0.matcher!, kind: 1, v2: undefined, maxTotalBps: 60 },
  flags: { ...ALL_ON, p2FeeCharged: true },
  riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: 1, maxRequestedFeeBps: 100, allDefault: false },
});

beforeEach(() => {
  mocks.limits = charged;
  mocks.mock = false;
  mocks.readFor = [];
});

describe("useCloseFeeEstimate", () => {
  it("a long's close on a fee-channel market: base + the requested fee", () => {
    const { result } = renderHook(() => useCloseFeeEstimate(50n * USD, 10n, 1_000_000n));
    expect(result.current(50n * USD)).toBe(70n);
  });
  it("a short's close is estimated too", () => {
    const { result } = renderHook(() => useCloseFeeEstimate(-50n * USD, 10n, 1_000_000n));
    expect(result.current(50n * USD)).toBe(70n);
  });
  it("CONTROL: channel off is the base fee", () => {
    mocks.limits = marketLimits();
    const { result } = renderHook(() => useCloseFeeEstimate(50n * USD, 10n, 1_000_000n));
    expect(result.current(50n * USD)).toBe(10n);
  });
  it("CONTROL: a mock market and no position are the base fee", () => {
    mocks.mock = true;
    expect(renderHook(() => useCloseFeeEstimate(50n * USD, 10n, 1_000_000n)).result.current(50n * USD)).toBe(10n);
    mocks.mock = false;
    expect(renderHook(() => useCloseFeeEstimate(0n, 10n, 1_000_000n)).result.current(50n * USD)).toBe(10n);
  });

  it("a close is the OPPOSITE side, reducing the position (a long closes by selling, a short by buying)", () => {
    const long = closeOrderInput(charged, 50n * USD, 20n * USD, null, 1_000_000n);
    expect(long).toMatchObject({ direction: "short", sizeQ: 20n * USD, takerPosQ: 50n * USD });
    const short = closeOrderInput(charged, -50n * USD, 20n * USD, null, 1_000_000n);
    expect(short).toMatchObject({ direction: "long", sizeQ: 20n * USD, takerPosQ: -50n * USD });
    expect(closeOrderInput(charged, 50n * USD, 1n, null, 0n).markE6).toBeUndefined();
  });

  it("limits the caller already reads are reused, and no second read is started (the ticket and the dock)", () => {
    mocks.limits = marketLimits(); // what the hook's own read WOULD return (channel off)
    const { result } = renderHook(() => useCloseFeeEstimate(50n * USD, 10n, 1_000_000n, charged));
    expect(result.current(50n * USD)).toBe(70n); // the caller's (charged) limits, not the own read
    expect(mocks.readFor.every((x) => x === null)).toBe(true);
  });
  it("CONTROL: without caller limits it reads this market's", () => {
    renderHook(() => useCloseFeeEstimate(50n * USD, 10n, 1_000_000n));
    expect(mocks.readFor.at(-1)).toBe("SLAB1111111111111111111111111111111111111111");
  });
});
