import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { ScenarioPanel } from "@/app/simulate/components/ScenarioPanel";

describe("ScenarioPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Default: API fails, component uses local simulation fallback
    mockFetch.mockRejectedValue(new Error("No API"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders section header", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    expect(screen.getByText("Market Scenarios")).toBeTruthy();
  });

  it("renders description text", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    expect(screen.getByText(/Vote to trigger/i)).toBeTruthy();
  });

  it("renders all 5 scenario cards", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    expect(screen.getByText("Flash Crash")).toBeTruthy();
    expect(screen.getByText("Short Squeeze")).toBeTruthy();
    expect(screen.getByText("Black Swan")).toBeTruthy();
    expect(screen.getByText("High Volatility")).toBeTruthy();
    expect(screen.getByText("Gentle Trend")).toBeTruthy();
  });

  it("renders scenario icons", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    expect(screen.getByText("💥")).toBeTruthy();
    expect(screen.getByText("🚀")).toBeTruthy();
    expect(screen.getByText("🦢")).toBeTruthy();
    expect(screen.getByText("⚡")).toBeTruthy();
  });

  it("renders scenario descriptions", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    expect(screen.getByText(/liquidation cascades/i)).toBeTruthy();
    expect(screen.getByText(/short closures/i)).toBeTruthy();
    expect(screen.getByText(/Maximum stress test/i)).toBeTruthy();
  });

  it("shows vote buttons", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    const voteButtons = screen.getAllByText("Vote");
    expect(voteButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("shows vote counts", async () => {
    await act(async () => {
      render(<ScenarioPanel />);
    });
    // Each scenario card shows "X votes" — at least 5 (one per scenario)
    const voteLabels = screen.getAllByText(/\d+ votes/i);
    expect(voteLabels.length).toBeGreaterThanOrEqual(5);
  });
});
