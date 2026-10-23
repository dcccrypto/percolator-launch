/**
 * MarketSwitcher lists: Top markets / My trades / Watchlist tabs, search across everything, per-tab empty
 * states, the remembered tab, keyboard and focus behaviour, and how My trades gets its positions (the shared
 * snapshot first, its own scan only as a fallback). Hooks are mocked at their boundaries; the lists come
 * from the real lib/market-switcher-lists helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const m = vi.hoisted(() => ({
  stats: { statsMap: new Map<string, Record<string, unknown>>(), loading: false, error: null as string | null },
  snapshot: null as null | { positions: unknown[] },
  fallback: { positions: [] as unknown[], loading: false, error: null as string | null },
  fallbackEnabled: [] as boolean[],
  connected: true,
  watchlist: [] as string[],
  unwatch: vi.fn(),
  push: vi.fn(),
  identity: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push, prefetch: vi.fn() }) }));
vi.mock("@/hooks/useAllMarketStats", () => ({ useAllMarketStats: () => m.stats }));
vi.mock("@/hooks/usePortfolio", () => ({
  usePortfolio: (enabled: boolean) => {
    m.fallbackEnabled.push(enabled);
    return m.fallback;
  },
  peekPortfolioSnapshot: () => m.snapshot,
  portfolioCacheKey: (w: string, n: string) => `${w}|${n}`,
}));
vi.mock("@/lib/config", () => ({ getNetwork: () => "devnet" }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: m.connected, publicKey: m.connected ? { toBase58: () => "WALLET" } : null }),
}));
vi.mock("@/hooks/useWatchlist", () => ({ useWatchlist: () => ({ watchlist: m.watchlist, unwatch: m.unwatch }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/marketIdentityCache", () => ({ setMarketIdentity: m.identity }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/lib/listed-markets", () => ({ isBrowsableMarketRow: () => true }));

import { MarketSwitcher } from "@/components/trade/MarketSwitcher";

const SOL = "SoLslab1111111111111111111111111111111111";
const JUP = "JUPslab1111111111111111111111111111111111";
const WIF = "WIFslab1111111111111111111111111111111111";
const BONK = "BONKslab111111111111111111111111111111111";

const pos = (slabAddress: string, symbol: string | null, size: bigint) => ({ slabAddress, symbol, account: { positionSize: size } });

function openSwitcher() {
  render(<MarketSwitcher slabAddress={SOL} symbol="SOL" />);
  fireEvent.click(screen.getByTitle("Switch market"));
}
const rowButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-switcher-row]"));
const rows = () => rowButtons().map((o) => o.textContent ?? "");
const row = (name: RegExp) => rowButtons().find((b) => name.test(b.textContent ?? ""))!;
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const search = () => screen.getByPlaceholderText("Search markets…");

beforeEach(() => {
  window.localStorage.clear();
  m.stats = {
    statsMap: new Map([
      [SOL, { symbol: "SOL", name: "Solana", last_price: 104.82, total_open_interest: 100 }],
      [JUP, { symbol: "JUP", name: "Jupiter", last_price: 0.3049, total_open_interest: 50 }],
      [WIF, { symbol: "WIF", name: "dogwifhat", last_price: 0.2275, total_open_interest: 40 }],
      [BONK, { symbol: "BONK", name: "Bonk", last_price: 0.0000074, total_open_interest: 1 }],
    ]),
    loading: false,
    error: null,
  };
  m.snapshot = { positions: [] };
  m.fallback = { positions: [], loading: false, error: null };
  m.fallbackEnabled = [];
  m.connected = true;
  m.watchlist = [];
  m.push.mockReset();
  m.identity.mockReset();
  m.unwatch.mockReset();
});
afterEach(cleanup);

describe("MarketSwitcher tabs", () => {
  it("shows three tabs and opens on Top markets (top 3 by open interest)", () => {
    openSwitcher();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Top markets", "My trades", "Watchlist"]);
    expect(tab(/top markets/i)).toHaveAttribute("aria-selected", "true");
    expect(rows()).toHaveLength(3);
    expect(rows()[0]).toMatch(/^SOL\/USD/);
  });

  it("My trades lists markets with an open position, each with its side; the count is announced", () => {
    m.snapshot = { positions: [pos(JUP, "JUP", 4n), pos(WIF, "WIF", -2n), pos(BONK, "BONK", 0n)] };
    openSwitcher();
    expect(tab(/my trades/i)).toHaveAccessibleName("My trades, 2");
    fireEvent.click(tab(/my trades/i));
    expect(rows()).toEqual([expect.stringMatching(/^JUP\/USD.*long/), expect.stringMatching(/^WIF\/USD.*short/)]);
  });

  it("Watchlist lists starred markets in the watchlist's order; the count matches the rows shown", () => {
    m.watchlist = [WIF, "Gone1111111111111111111111111111111111111", BONK];
    openSwitcher();
    expect(tab(/watchlist/i)).toHaveAccessibleName("Watchlist, 2"); // the delisted one isn't shown, so isn't counted
    fireEvent.click(tab(/watchlist/i));
    expect(rows().map((r) => r.split("/")[0])).toEqual(["WIF", "BONK"]);
  });

  it("clicking a row goes to that market and caches its real name", () => {
    m.watchlist = [JUP];
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    fireEvent.click(row(/JUP/));
    expect(m.push).toHaveBeenCalledWith(`/trade/${JUP}`);
    expect(m.identity).toHaveBeenCalledWith(JUP, { symbol: "JUP", name: "Jupiter" });
  });

  it("a position in a market not in the list yet opens it without caching a stand-in name", () => {
    const NEW = "NEWslab1111111111111111111111111111111111";
    m.snapshot = { positions: [pos(NEW, null, 1n)] };
    openSwitcher();
    fireEvent.click(tab(/my trades/i));
    fireEvent.click(rowButtons()[0]);
    expect(m.push).toHaveBeenCalledWith(`/trade/${NEW}`);
    expect(m.identity).not.toHaveBeenCalled();
  });

  it("Enter opens the first market of the list on screen", () => {
    m.watchlist = [WIF];
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(m.push).toHaveBeenCalledWith(`/trade/${WIF}`);
  });

  it("search covers every market whichever tab is open, and hides the tabs while typing", () => {
    m.watchlist = [WIF];
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    fireEvent.change(search(), { target: { value: "jup" } });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(rows().map((r) => r.split("/")[0])).toEqual(["JUP"]);
  });

  it("remembers the last tab for the next open", () => {
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    cleanup();
    openSwitcher();
    expect(tab(/watchlist/i)).toHaveAttribute("aria-selected", "true");
  });
});

describe("My trades reads the shared positions snapshot", () => {
  it("with a snapshot it never starts its own scan, on any tab", () => {
    m.snapshot = { positions: [pos(JUP, "JUP", 1n)] };
    openSwitcher();
    fireEvent.click(tab(/my trades/i));
    expect(rows()).toHaveLength(1);
    expect(m.fallbackEnabled.every((e) => e === false)).toBe(true);
  });

  it("reopened on My trades (the remembered tab) with a warm snapshot, it never starts its own scan, not even on the first render", () => {
    m.snapshot = { positions: [pos(JUP, "JUP", 1n)] };
    openSwitcher();
    fireEvent.click(tab(/my trades/i));
    cleanup();
    m.fallbackEnabled = [];
    openSwitcher();
    expect(tab(/my trades/i)).toHaveAttribute("aria-selected", "true");
    expect(rows()).toHaveLength(1);
    expect(m.fallbackEnabled.length).toBeGreaterThan(0);
    expect(m.fallbackEnabled.every((e) => e === false)).toBe(true);
  });

  it("with no snapshot it scans only while My trades is open", () => {
    m.snapshot = null;
    openSwitcher();
    expect(m.fallbackEnabled.at(-1)).toBe(false); // Top markets: no scan
    fireEvent.click(tab(/my trades/i));
    expect(m.fallbackEnabled.at(-1)).toBe(true);
  });

  it("closed, it never scans", () => {
    m.snapshot = null;
    render(<MarketSwitcher slabAddress={SOL} symbol="SOL" />);
    expect(m.fallbackEnabled.every((e) => e === false)).toBe(true);
  });

  it("re-reads the snapshot while open, so a newly opened position appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.snapshot = { positions: [] };
      openSwitcher();
      fireEvent.click(tab(/my trades/i));
      expect(screen.getByText("No open positions")).toBeInTheDocument();
      m.snapshot = { positions: [pos(WIF, "WIF", 3n)] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(rows()).toEqual([expect.stringMatching(/^WIF\/USD.*long/)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("empty states", () => {
  it("signed out: asks to connect, and nothing scans", () => {
    m.connected = false;
    openSwitcher();
    fireEvent.click(tab(/my trades/i));
    expect(screen.getByText("Connect your wallet to see your trades")).toBeInTheDocument();
    expect(m.fallbackEnabled.every((e) => e === false)).toBe(true);
  });

  it("no snapshot: loading, failed, and no positions each say so (announced, outside the list)", () => {
    m.snapshot = null;
    m.fallback = { positions: [], loading: true, error: null };
    openSwitcher();
    fireEvent.click(tab(/my trades/i));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading your positions…");
    expect(within(screen.getByRole("list")).queryByText("Loading your positions…")).toBeNull();
    cleanup();

    m.fallback = { positions: [], loading: false, error: "rpc" };
    openSwitcher();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load your positions");
    cleanup();

    m.fallback = { positions: [], loading: false, error: null };
    openSwitcher();
    expect(screen.getByRole("status")).toHaveTextContent("No open positions");
  });

  it("an empty watchlist says how to add one", () => {
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    expect(screen.getByRole("status")).toHaveTextContent("Star a market with ☆ to add it here");
  });

  it("watched markets that aren't listed say so instead of an empty panel", () => {
    m.watchlist = ["GoneSlab11111111111111111111111111111111"];
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    expect(screen.getByRole("status")).toHaveTextContent("Your watched markets aren't listed right now");
  });
});

describe("keyboard and focus", () => {
  it("tabs follow the ARIA pattern: one tab stop, arrow keys and Home/End move and select", () => {
    openSwitcher();
    expect(tab(/top markets/i)).toHaveAttribute("tabindex", "0");
    expect(tab(/my trades/i)).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(tab(/top markets/i), { key: "ArrowRight" });
    expect(tab(/my trades/i)).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab(/my trades/i));
    fireEvent.keyDown(tab(/my trades/i), { key: "End" });
    expect(tab(/watchlist/i)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(/watchlist/i), { key: "ArrowRight" }); // wraps
    expect(tab(/top markets/i)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(/top markets/i), { key: "ArrowLeft" }); // wraps back
    expect(tab(/watchlist/i)).toHaveAttribute("aria-selected", "true");
  });

  it("the current market is marked for screen readers", () => {
    openSwitcher();
    expect(row(/SOL/)).toHaveAttribute("aria-current", "true");
    expect(row(/JUP/)).not.toHaveAttribute("aria-current");
  });

  it("the selected tab controls the list, and the list is labelled by it", () => {
    openSwitcher();
    const list = screen.getByRole("list");
    expect(tab(/top markets/i)).toHaveAttribute("aria-controls", list.id);
    expect(list).toHaveAttribute("aria-labelledby", tab(/top markets/i).id);
  });

  it("ArrowDown from search moves into the rows, ArrowUp from the first row back to search", () => {
    openSwitcher();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    const first = rowButtons()[0];
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowButtons()[1]);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search());
  });

  it("Escape closes and hands focus back to the market button", () => {
    openSwitcher();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByTitle("Switch market"));
  });

  it("choosing a market hands focus back to the market button", () => {
    openSwitcher();
    fireEvent.click(rowButtons()[1]);
    expect(document.activeElement).toBe(screen.getByTitle("Switch market"));
  });

  it("focus moving outside the panel closes it", () => {
    render(
      <>
        <MarketSwitcher slabAddress={SOL} symbol="SOL" />
        <button type="button">elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByTitle("Switch market"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => {
      screen.getByRole("button", { name: "elsewhere" }).focus();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the trigger announces a dialog", () => {
    render(<MarketSwitcher slabAddress={SOL} symbol="SOL" />);
    expect(screen.getByTitle("Switch market")).toHaveAttribute("aria-haspopup", "dialog");
  });
});

describe("Watchlist quick remove", () => {
  it("each watchlist row has a remove button that unstars it without opening the market", () => {
    m.watchlist = [WIF, BONK];
    openSwitcher();
    fireEvent.click(tab(/watchlist/i));
    const remove = screen.getByRole("button", { name: "Remove WIF/USD from your watchlist" });
    fireEvent.click(remove);
    expect(m.unwatch).toHaveBeenCalledWith(WIF);
    expect(m.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // stays open to keep editing
  });

  it("there is no remove button on Top markets, My trades or search results", () => {
    m.watchlist = [WIF];
    m.snapshot = { positions: [pos(WIF, "WIF", 1n)] };
    openSwitcher();
    expect(screen.queryByRole("button", { name: /from your watchlist/ })).toBeNull();
    fireEvent.click(tab(/my trades/i));
    expect(screen.queryByRole("button", { name: /from your watchlist/ })).toBeNull();
    fireEvent.click(tab(/watchlist/i));
    fireEvent.change(search(), { target: { value: "wif" } });
    expect(screen.queryByRole("button", { name: /from your watchlist/ })).toBeNull();
  });
});

describe("My trades stays accurate", () => {
  it("a position closed since the last read drops off the list on the next read", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      m.snapshot = { positions: [pos(JUP, "JUP", 4n), pos(WIF, "WIF", -2n)] };
      openSwitcher();
      fireEvent.click(tab(/my trades/i));
      expect(rows()).toHaveLength(2);
      // WIF closed: the next scan reports it at size 0 (or not at all).
      m.snapshot = { positions: [pos(JUP, "JUP", 4n), pos(WIF, "WIF", 0n)] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(rows()).toEqual([expect.stringMatching(/^JUP\/USD.*long/)]);
      expect(tab(/my trades/i)).toHaveAccessibleName("My trades, 1");
    } finally {
      vi.useRealTimers();
    }
  });
});
