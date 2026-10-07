/**
 * The landing rail lists markets from /api/markets (useAllMarketStats), not
 * PLAYGROUND_SLAB_META. The 2026-10-01 relaunch emptied that table, and the
 * rail rendered its header with no rows while /markets listed the live ones.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  stats: { statsMap: new Map(), loading: false, error: null as string | null },
}));

vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => h.stats }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/priceStore/priceStore", () => ({
  subscribeSlab: () => () => {},
  getSnapshot: () => ({ priceUsd: null, priceE6: null }),
}));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
// Each row polls /api/prices for the 24h change via SWR — keep it inert so the
// rows test stays a pure render (no network); the 24h column just reads "—".
vi.mock("swr", () => ({ default: () => ({ data: undefined, error: undefined, isLoading: false }) }));

import { LiveMarketRail } from "@/components/landing/LiveMarketRail";
import { HARDCODED_BLOCKED_SLABS } from "@/lib/blocklist-data";

const row = (slab: string, symbol: string, vol: number, extra: Record<string, unknown> = {}) => [
  slab,
  { slab_address: slab, symbol, name: `${symbol} name`, mainnet_ca: null, last_price: 1, volume_24h_usd: vol, max_leverage: 10, ...extra },
];
const setStats = (rows: unknown[][], over: Partial<typeof h.stats> = {}) => {
  h.stats = { statsMap: new Map(rows as [string, unknown][]), loading: false, error: null, ...over };
};
const links = () => screen.queryAllByRole("link").map((a) => a.getAttribute("href"));

afterEach(() => setStats([]));

describe("LiveMarketRail rows", () => {
  it("lists the API's markets after the relaunch, busiest first, without zombies", () => {
    setStats([
      row("9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn", "Percolator", 10),
      row("Azagguvr111111111111111111111111111111111111", "SOL", 50),
      // Listing-hidden (lib/listing-hidden DEFAULT_HIDDEN): reachable by URL, never listed.
      row("8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx", "SI", 500),
      // A-6 orphan (Hm1bapsZ… shape): explicit null price source -> never listed.
      row("Hm1bapsZ111111111111111111111111111111111111", "ORPHAN", 400, { dex_pool_address: null }),
      // Dead by isZombieMarket (empty vault, no price, no accounts), as /markets judges it.
      row("ZombieSLab1111111111111111111111111111111111", "DEAD", 99, { vault_balance: 0, c_tot: 0, last_price: null, total_accounts: 0 }),
    ]);
    render(<LiveMarketRail />);
    expect(links()).toEqual([
      "/trade/Azagguvr111111111111111111111111111111111111",
      "/trade/9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn",
    ]);
    expect(screen.queryByText("DEAD")).toBeNull();
    expect(screen.queryByText("SI")).toBeNull();
    expect(screen.queryByText("ORPHAN")).toBeNull();
  });

  it("applies /markets' exact listing rule: blocklist, and string/over-cap coercion", () => {
    const blocked = [...HARDCODED_BLOCKED_SLABS][0];
    setStats([
      row("Azagguvr111111111111111111111111111111111111", "SOL", 50),
      row(blocked, "BLOCKED", 99),
      // Empty vault as the string "0" and a corrupt over-cap price: /markets
      // sanitises the price away, so this is a zombie there and must be here.
      row("CorruptSlab111111111111111111111111111111111", "CORRUPT", 98, { vault_balance: "0", c_tot: "0", last_price: "7900000000000", total_accounts: "0" }),
    ]);
    render(<LiveMarketRail />);
    expect(links()).toEqual(["/trade/Azagguvr111111111111111111111111111111111111"]);
  });

  it("shows up to the default 20 busiest rows, in order", () => {
    setStats(Array.from({ length: 9 }, (_, i) => row(`slab${i}`, `M${i}`, i)));
    render(<LiveMarketRail />);
    // Default "Show 20" — all 9 listed markets, busiest first (the /trade links only;
    // the error/empty CTA links aren't present here).
    expect(links()).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0].map((i) => `/trade/slab${i}`));
  });

  it("the Show control caps the rail (Show 5 → the five busiest, in order)", () => {
    setStats(Array.from({ length: 9 }, (_, i) => row(`slab${i}`, `M${i}`, i)));
    render(<LiveMarketRail />);
    fireEvent.click(screen.getByRole("radio", { name: "5" }));
    expect(links()).toEqual([8, 7, 6, 5, 4].map((i) => `/trade/slab${i}`));
  });

  it("orders zero-volume markets by slab so a refetch can't reshuffle them", () => {
    setStats([row("bSlab", "B", 0), row("aSlab", "A", 0)]);
    render(<LiveMarketRail />);
    expect(links()).toEqual(["/trade/aSlab", "/trade/bSlab"]);
  });

  it("says there are no markets once loaded empty", () => {
    render(<LiveMarketRail />);
    expect(screen.getByRole("link", { name: /No markets yet/ }).getAttribute("href")).toBe("/create");
  });

  it("does not claim 'no markets' when the fetch failed", () => {
    setStats([], { error: "Markets API returned 500" });
    render(<LiveMarketRail />);
    expect(screen.queryByText(/No markets yet/)).toBeNull();
    expect(screen.getByRole("link", { name: /Couldn.t load markets/ }).getAttribute("href")).toBe("/markets");
  });

  it("keeps the error while SWR retries a failed first load", () => {
    setStats([], { loading: true, error: "Markets API returned 500" });
    render(<LiveMarketRail />);
    expect(screen.getByRole("link", { name: /Couldn.t load markets/ })).toBeTruthy();
  });

  it("shows no message while loading", () => {
    setStats([], { loading: true });
    render(<LiveMarketRail />);
    expect(links()).toEqual([]);
  });
});
