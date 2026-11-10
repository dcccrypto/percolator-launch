/**
 * Council r4 N5: with every RPC read failing the header kept a green LIVE badge beside a greyed-out ticket. Mounts the
 * real MarketInfoBar with the slab read failing (polls failing over stale data, and a first read that errored): the
 * badge must not read LIVE. Control: a healthy slab with a fresh price still reads LIVE.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const slab = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceUsd: 151.25, priceE6: 151_250_000n, change24h: null }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: null }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, fundingRate: null, totalOI: null, insuranceBalance: null, hasData: false }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh" }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useHeaderPriceFacts", () => ({ useHeaderPriceFacts: () => undefined }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => slab.value }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => "" }));
vi.mock("@/components/trade/MarketSwitcher", () => ({ MarketSwitcher: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/trade/TokenCopyMenu", () => ({ TokenCopyMenu: () => null }));
vi.mock("@/lib/tv/data", () => ({ getLiveClient: () => null }));

import { MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { __resetPriceFreshnessForTests, markPriceFresh } from "@/lib/price-freshness";

const SLAB = "RpcDownSlab1111111111111111111111111111111111";
const badge = () => screen.getByTestId("market-health-badge");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
  __resetPriceFreshnessForTests();
  slab.value = {};
});
afterEach(() => vi.useRealTimers());

describe("N5: header badge under RPC failure", () => {
  it("CONTROL: healthy read + fresh price is LIVE", () => {
    render(<MarketInfoBar slabAddress={SLAB} symbol="SOL" />);
    act(() => markPriceFresh(SLAB));
    expect(badge()).toHaveTextContent("LIVE");
  });

  it("slab polls failing over stale data: not LIVE, says no connection", () => {
    slab.value = { readFailing: true };
    render(<MarketInfoBar slabAddress={SLAB} symbol="SOL" />);
    act(() => markPriceFresh(SLAB));
    expect(badge()).not.toHaveTextContent("LIVE");
    expect(badge().getAttribute("data-state")).toBe("rpc-down");
    expect(badge()).toHaveTextContent("NO CONNECTION");
  });

  it("first read errored with nothing loaded: not LIVE", () => {
    slab.value = { error: "RPC error: 503", config: null };
    render(<MarketInfoBar slabAddress={SLAB} symbol="SOL" />);
    act(() => markPriceFresh(SLAB));
    expect(badge().getAttribute("data-state")).toBe("rpc-down");
  });
});
