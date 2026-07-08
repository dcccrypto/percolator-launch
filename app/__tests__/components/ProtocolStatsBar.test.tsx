/**
 * ProtocolStatsBar — data-source + "live" gating tests.
 *
 * M13/H10 (2026-07-08): ProtocolStatsBar used to query the `markets_with_stats`
 * Supabase view directly and re-derive OI/volume/phantom-market filtering
 * client-side. That view is dead in the playground (D-OPS2), so the card
 * silently rendered $0/$0/0 under an always-on pulsing "live" dot. It now
 * fetches the same aggregate from /api/stats (which has its own OI/phantom/
 * blocked-slab coverage — see __tests__/api/stats-phantom-oi-guard.test.ts)
 * and only shows the "live" pulse when that endpoint reports `live: true`.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ProtocolStatsBar } from "@/components/dashboard/ProtocolStatsBar";
import "@testing-library/jest-dom";

function mockStatsResponse(body: Record<string, unknown>, ok = true) {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe("ProtocolStatsBar — /api/stats data source", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders zero stats when /api/stats reports no data", async () => {
    mockStatsResponse({
      totalMarkets: 0,
      activeTotal: 0,
      totalVolume24h: 0,
      totalOpenInterest: 0,
      totalTraders: 0,
      trades24h: 0,
      live: false,
    });

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("Open Interest")).toBeInTheDocument();
      expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
      expect(screen.getByText("Active Markets")).toBeInTheDocument();
      expect(screen.getByText("0")).toBeInTheDocument();
    });
  });

  it("renders real volume/OI/active-market counts from a live response", async () => {
    mockStatsResponse({
      totalMarkets: 3,
      activeTotal: 3,
      totalVolume24h: 12_500,
      totalOpenInterest: 50_000,
      totalTraders: 7,
      trades24h: 42,
      live: true,
    });

    render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("$12.5K")).toBeInTheDocument();
      expect(screen.getByText("$50.0K")).toBeInTheDocument();
      expect(screen.getByText("Active Markets")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("shows the pulsing live indicator only when /api/stats reports live: true", async () => {
    mockStatsResponse({
      totalMarkets: 1,
      activeTotal: 1,
      totalVolume24h: 100,
      totalOpenInterest: 100,
      totalTraders: 1,
      trades24h: 1,
      live: true,
    });

    const { container } = render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(container.querySelector(".animate-ping")).toBeInTheDocument();
    });
  });

  it("hides the live indicator when /api/stats degrades to its zero-stats fallback", async () => {
    mockStatsResponse({
      totalMarkets: 0,
      activeTotal: 0,
      totalVolume24h: 0,
      totalOpenInterest: 0,
      totalTraders: 0,
      trades24h: 0,
      live: false,
    });

    const { container } = render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("Open Interest")).toBeInTheDocument();
    });
    expect(container.querySelector(".animate-ping")).not.toBeInTheDocument();
  });

  it("hides the live indicator when the fetch itself fails", async () => {
    mockStatsResponse({}, false);

    const { container } = render(<ProtocolStatsBar />);

    await waitFor(() => {
      expect(screen.getByText("Open Interest")).toBeInTheDocument();
    });
    expect(container.querySelector(".animate-ping")).not.toBeInTheDocument();
  });
});
