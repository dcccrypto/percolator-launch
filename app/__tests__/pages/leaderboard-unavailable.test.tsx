/**
 * GH#2709: when /api/leaderboard fails, the page shows its error panel and
 * nothing that claims the board was read: no "Not ranked yet", and no rank,
 * footer or CTA carried over from an earlier successful load.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const WALLET = "DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG";

vi.mock("gsap", () => ({ default: { fromTo: vi.fn(), killTweensOf: vi.fn() } }));
vi.mock("@/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => true }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: { toBase58: () => WALLET }, connected: true }),
}));

import LeaderboardPage from "@/app/leaderboard/page";

const ok = () =>
  new Response(
    JSON.stringify({
      leaderboard: [{ rank: 1, trader: WALLET, tradeCount: 3, totalVolume: 1000, lastTradeAt: "2026-09-29T00:00:00Z" }],
      period: "24h",
      generatedAt: new Date().toISOString(),
    }),
    { status: 200 },
  );
const unavailable = () =>
  new Response(JSON.stringify({ error: "Leaderboard temporarily unavailable", unavailable: true, leaderboard: [] }), {
    status: 503,
  });

afterEach(() => vi.unstubAllGlobals());

describe("leaderboard page on a 503 (GH#2709)", () => {
  it("first load: shows the error, not 'No trades' or 'Not ranked yet'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unavailable()));
    await act(async () => { render(<LeaderboardPage />); });

    expect(await screen.findByText(/temporarily down/i)).toBeTruthy();
    expect(screen.queryByText(/No trades this period/i)).toBeNull();
    expect(screen.queryByText(/Not ranked yet/i)).toBeNull();
  });

  it("refresh after a success: drops the stale rank, footer and CTA", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok()).mockResolvedValueOnce(unavailable());
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => { render(<LeaderboardPage />); });
    expect(await screen.findByText(/Top 1 traders/)).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByTitle("Refresh")); });

    expect(await screen.findByText(/temporarily down/i)).toBeTruthy();
    expect(screen.queryByText(/Top 1 traders/)).toBeNull();
    expect(screen.queryByText(/^Updated /)).toBeNull();
    expect(screen.queryByText(/Want to climb the board/i)).toBeNull();
    expect(screen.queryByText(/Share on/)).toBeNull();
  });
});
