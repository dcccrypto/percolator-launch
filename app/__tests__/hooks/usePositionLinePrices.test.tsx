import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ua: null as unknown,
  liq: null as bigint | null,
  config: null as unknown,
  cached: 0n,
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => m.ua }));
vi.mock("@/hooks/useLiqPrice", () => ({ useLiqPrice: () => m.liq }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => m.config }));
vi.mock("@/lib/entry-price", () => ({ getEntryPrice: () => m.cached }));

import { usePositionLinePrices } from "@/hooks/usePositionLinePrices";

const owner = { toBase58: () => "OWNER" };
const acct = (over: Record<string, unknown>) => ({ idx: 1, account: { positionSize: 1_000_000n, entryPrice: 0n, pnl: 0n, owner, ...over } });

beforeEach(() => { m.ua = null; m.liq = null; m.config = { lastEffectivePriceE6: 3_600n, invert: 0 }; m.cached = 0n; });

describe("usePositionLinePrices", () => {
  it("no position: no lines", () => {
    expect(renderHook(() => usePositionLinePrices("S")).result.current).toEqual({ liq: null, entry: null });
    m.ua = acct({ positionSize: 0n });
    expect(renderHook(() => usePositionLinePrices("S")).result.current.entry).toBeNull();
  });
  it("draws the wallet-cached entry through the display contract", () => {
    m.ua = acct({});
    m.cached = 3_400n;
    expect(renderHook(() => usePositionLinePrices("S")).result.current.entry).toBeCloseTo(0.0034, 9);
  });
  it("an on-chain entry (when present) is used", () => {
    m.ua = acct({ entryPrice: 3_500n });
    expect(renderHook(() => usePositionLinePrices("S")).result.current.entry).toBeCloseTo(0.0035, 9);
  });
  it("NEGATIVE CONTROL: an entry whose source is unknown draws NO line (never falls back to the mark)", () => {
    m.ua = acct({});     // nothing cached, no pnl-derivable entry
    m.config = null;     // and no oracle price to derive from
    expect(renderHook(() => usePositionLinePrices("S")).result.current.entry).toBeNull();
  });
  it("liq: only for a positive price", () => {
    m.liq = 2_100n;
    expect(renderHook(() => usePositionLinePrices("S")).result.current.liq).toBeCloseTo(0.0021, 9);
    m.liq = 0n;
    expect(renderHook(() => usePositionLinePrices("S")).result.current.liq).toBeNull();
    m.liq = null;
    expect(renderHook(() => usePositionLinePrices("S")).result.current.liq).toBeNull();
  });
});
