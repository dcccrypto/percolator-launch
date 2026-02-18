import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock useEngineState with real shape
vi.mock("@/hooks/useEngineState", () => ({
  useEngineState: vi.fn(() => ({
    engine: {
      lifetimeLiquidations: 0n,
      lastCrankSlot: 100n,
    },
    fundingRate: 100n,
    insuranceFund: { balance: 5000000000n },
    totalOI: 1000000000000n,
    loading: false,
  })),
}));

import { EventFeed } from "@/app/simulate/components/EventFeed";

describe("EventFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Event Feed header", () => {
    render(<EventFeed />);
    expect(screen.getByText("Event Feed")).toBeTruthy();
  });

  it("renders filter toggle button", () => {
    render(<EventFeed />);
    expect(screen.getByText(/Filter/i)).toBeTruthy();
  });

  it("shows empty state message when no events", () => {
    render(<EventFeed />);
    expect(screen.getByText(/Listening for market events/i)).toBeTruthy();
  });

  it("shows filter chips when filter button clicked", () => {
    render(<EventFeed />);
    const filterBtn = screen.getByText(/Filter/i);
    fireEvent.click(filterBtn);
    // After clicking, should show "Hide filters" and filter chips
    expect(screen.getByText(/Hide filters/i)).toBeTruthy();
  });

  it("has live indicator", () => {
    render(<EventFeed />);
    // Live indicator dot exists (it's a span with animate-ping class)
    const dots = document.querySelectorAll(".animate-ping");
    expect(dots.length).toBeGreaterThan(0);
  });
});
