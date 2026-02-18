import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

// Track interval to prevent infinite polling
const origSetInterval = globalThis.setInterval;
const origClearInterval = globalThis.clearInterval;
const intervals: ReturnType<typeof setInterval>[] = [];

vi.stubGlobal("setInterval", (...args: Parameters<typeof setInterval>) => {
  const id = origSetInterval(...args);
  intervals.push(id);
  return id;
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({
    connected: true,
    publicKey: { toBase58: () => "testWallet123" },
  })),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

import { SimLeaderboard } from "@/app/simulate/components/SimLeaderboard";

const MOCK_ENTRIES = [
  {
    rank: 1,
    wallet: "ABcDeFgHiJkLmNoPqRsTuVwXyZ12345678901234",
    display_name: "TopTrader",
    total_pnl: 5000,
    total_deposited: 10000,
    trade_count: 42,
    win_count: 30,
    liquidation_count: 1,
    best_trade: 2000,
    worst_trade: -500,
    roi_pct: 50,
    win_rate: 71.4,
  },
];

describe("SimLeaderboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries: MOCK_ENTRIES, weekStart: new Date().toISOString() }),
      })
    );
  });

  afterEach(() => {
    // Clear all intervals set during test to prevent polling leaks
    intervals.forEach((id) => origClearInterval(id));
    intervals.length = 0;
  });

  it("renders leaderboard header", async () => {
    await act(async () => { render(<SimLeaderboard />); });
    expect(screen.getAllByText(/Leaderboard/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders period tabs", async () => {
    await act(async () => { render(<SimLeaderboard />); });
    expect(screen.getByText("This Week")).toBeTruthy();
    expect(screen.getByText("All-Time")).toBeTruthy();
  });

  it("fetches leaderboard on mount", async () => {
    await act(async () => { render(<SimLeaderboard />); });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/simulate/leaderboard"),
      expect.anything()
    );
  });

  it("renders entries after data loads", async () => {
    await act(async () => {
      render(<SimLeaderboard />);
      // Let the initial fetch promise resolve and state update
      await new Promise((r) => setTimeout(r, 50));
    });
    // "TopTrader" should now be in the document (mobile cards + desktop table)
    expect(screen.getAllByText("TopTrader").length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no entries", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ entries: [], weekStart: new Date().toISOString() }),
      })
    );
    await act(async () => {
      render(<SimLeaderboard />);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(/No trades yet/i)).toBeTruthy();
  });

  it("has refresh button", async () => {
    await act(async () => { render(<SimLeaderboard />); });
    expect(screen.getByTitle("Refresh")).toBeTruthy();
  });

  it("renders table headers", async () => {
    await act(async () => {
      render(<SimLeaderboard />);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText("PnL")).toBeTruthy();
  });
});
