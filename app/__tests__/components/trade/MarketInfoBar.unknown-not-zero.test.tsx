/**
 * #38: the market header showed a fake "0.00%" when the 24h change was unknown, and with no live
 * price it rendered open interest as the bare token count with a "$" (100 SOL OI read "$100").
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  live: { priceUsd: null as number | null, priceE6: null as bigint | null, change24h: null as number | null },
  totalOI: null as bigint | null,
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => h.live }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: null }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, totalOI: h.totalOI, insuranceBalance: 1n, hasData: true }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({}) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({}) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => "" }));
vi.mock("@/components/trade/MarketSwitcher", () => ({ MarketSwitcher: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/trade/TokenCopyMenu", () => ({ TokenCopyMenu: () => null }));

import { MarketInfoBar } from "@/components/trade/MarketInfoBar";

const bar = () => render(<MarketInfoBar slabAddress="S" symbol="SOL" />);
const oiValue = () => screen.getByText("Open Interest").nextElementSibling?.textContent;

describe("unknown header figures read '—', not a fake zero (#38)", () => {
  it("no 24h change: '—', not 0.00%", () => {
    h.live = { priceUsd: 100, priceE6: 100_000_000n, change24h: null };
    h.totalOI = null;
    bar();
    expect(screen.queryByText("0.00%")).toBeNull();
    // The badge right after the mark price (not just any "—" in the header).
    expect(screen.getByTestId("header-price").nextElementSibling?.textContent).toBe("—");
  });

  it("zero OI is a real $0 even with no price", () => {
    h.live = { priceUsd: null, priceE6: null, change24h: 1.5 };
    h.totalOI = 0n;
    bar();
    expect(oiValue()).toMatch(/^\$0/);
  });

  it("OI with no live price: '—', not the token count as dollars", () => {
    h.live = { priceUsd: null, priceE6: null, change24h: 1.5 };
    h.totalOI = 100_000_000n; // 100 tokens (Q 1e6)
    bar();
    expect(oiValue()).toBe("—");
  });

  it("CONTROL: OI with a live price is the USD value", () => {
    h.live = { priceUsd: 2, priceE6: 2_000_000n, change24h: 1.5 };
    h.totalOI = 100_000_000n;
    bar();
    expect(oiValue()).toBe("$200.00");
  });
});
