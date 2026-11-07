/**
 * Council 2026-11-07 council-leftovers run 2, finding 1 (HIGH; Clerk, First-timer, Trader): the chart read Offline /
 * Delayed next to a green LIVE header badge and a "$" header price, and with the feed dead the header badge never went
 * stale. The page header (MarketInfoBar) and the chart strip (usePerpLiveStrip; PerpChart reads the same hook) now
 * read ONE clock (lib/price-freshness.ts). This renders the real MarketInfoBar next to the real strip hook on the same
 * slab and checks they agree live, after 30 s of silence (dead feed) and after 61 s, and recover together.
 */
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceUsd: 151.25, priceE6: 151_250_000n, change24h: null }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: null }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, fundingRate: null, totalOI: null, insuranceBalance: null, hasData: false }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh" }) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/hooks/useHeaderPriceFacts", () => ({ useHeaderPriceFacts: () => undefined }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({}) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => "" }));
vi.mock("@/components/trade/MarketSwitcher", () => ({ MarketSwitcher: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/trade/TokenCopyMenu", () => ({ TokenCopyMenu: () => null }));
vi.mock("@/lib/tv/data", () => ({ getLiveClient: () => null }));

import { healthBadgeState, MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { usePerpLiveStrip } from "@/hooks/usePerpLiveStrip";
import { __resetPriceFreshnessForTests, markPriceFresh } from "@/lib/price-freshness";

const SLAB = "AgreeSlab11111111111111111111111111111111111";
const BADGE_FOR = { live: "live", delayed: "price-delayed", offline: "price-offline" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
  __resetPriceFreshnessForTests();
});
afterEach(() => vi.useRealTimers());

function mountBoth() {
  render(<MarketInfoBar slabAddress={SLAB} symbol="SOL" />);
  const strip = renderHook(() => usePerpLiveStrip(SLAB, "mark"));
  const badge = () => screen.getByTestId("market-health-badge");
  const price = () => screen.getByTestId("header-price");
  return { strip, badge, price };
}

describe("header badge and chart marker share one freshness clock", () => {
  it("agree before any price, while live, with the feed dead 30 s and 61 s, and after recovery", () => {
    const { strip, badge, price } = mountBoth();
    const check = (chart: "live" | "delayed" | "offline") => {
      expect(strip.result.current.live).toBe(chart);
      expect(badge().getAttribute("data-state")).toBe(BADGE_FOR[chart]);
      expect(price().getAttribute("data-last-known")).toBe(chart === "offline" ? "true" : null);
    };

    check("offline"); // nothing yet on this page: neither claims LIVE

    act(() => markPriceFresh(SLAB));
    check("live");
    expect(badge()).toHaveTextContent("LIVE");

    act(() => { vi.advanceTimersByTime(30_000); });
    check("delayed");
    expect(badge()).toHaveTextContent("DELAYED");
    expect(badge().getAttribute("title")).toMatch(/No new price for 30s/);

    act(() => { vi.advanceTimersByTime(31_000); });
    check("offline");
    expect(badge()).toHaveTextContent("OFFLINE");
    expect(screen.queryByText("LIVE")).toBeNull();

    act(() => markPriceFresh(SLAB));
    check("live");
  });
});

describe("healthBadgeState with the feed", () => {
  it("only a market that would read LIVE is downgraded; market states still outrank the feed", () => {
    expect(healthBadgeState(false, false, null, "live")).toBe("live");
    expect(healthBadgeState(false, false, null, "delayed")).toBe("price-delayed");
    expect(healthBadgeState(false, false, null, "offline")).toBe("price-offline");
    expect(healthBadgeState(true, false, null, "offline")).toBe("no-oracle");
    expect(healthBadgeState(false, true, null, "offline")).toBe("no-liquidity");
  });
});
