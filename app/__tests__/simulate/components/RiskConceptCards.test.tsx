import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock localStorage
const mockStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mockStorage[k] || null,
  setItem: (k: string, v: string) => { mockStorage[k] = v; },
  removeItem: (k: string) => { delete mockStorage[k]; },
});

// Mock useEngineState with real shape
vi.mock("@/hooks/useEngineState", () => ({
  useEngineState: vi.fn(() => ({
    engine: null,
    fundingRate: null,
    insuranceFund: null,
    totalOI: null,
    loading: true,
  })),
}));

import { RiskConceptCards } from "@/app/simulate/components/RiskConceptCards";
import { useEngineState } from "@/hooks/useEngineState";

describe("RiskConceptCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it("renders pnl-warmup card by default (always shown)", () => {
    render(<RiskConceptCards />);
    // pnl-warmup is always added to visible set on mount
    expect(screen.getByText("PnL Warmup")).toBeTruthy();
  });

  it("renders Risk Concepts header", () => {
    render(<RiskConceptCards />);
    expect(screen.getByText(/Risk Concepts/i)).toBeTruthy();
  });

  it("renders warmup icon", () => {
    render(<RiskConceptCards />);
    expect(screen.getByText("🔥")).toBeTruthy();
  });

  it("renders warmup summary", () => {
    render(<RiskConceptCards />);
    expect(screen.getByText(/warmup period/i)).toBeTruthy();
  });

  it("expands card on title click to show detail", () => {
    render(<RiskConceptCards />);
    // Click the title button to expand
    const titleBtn = screen.getByText("PnL Warmup").closest("button");
    expect(titleBtn).toBeTruthy();
    fireEvent.click(titleBtn!);
    // Should show detail text
    expect(screen.getByText(/oracle attack buffer/i)).toBeTruthy();
  });

  it("shows Learn More button when expanded", () => {
    render(<RiskConceptCards />);
    const titleBtn = screen.getByText("PnL Warmup").closest("button");
    fireEvent.click(titleBtn!);
    expect(screen.getByText(/Learn More/i)).toBeTruthy();
  });

  it("has dismiss button on each card", () => {
    render(<RiskConceptCards />);
    const dismissBtns = screen.getAllByLabelText(/Dismiss card/i);
    expect(dismissBtns.length).toBeGreaterThanOrEqual(1);
  });

  it("dismisses card on click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<RiskConceptCards />);
    const dismissBtn = screen.getByLabelText(/Dismiss card/i);
    fireEvent.click(dismissBtn);
    // Wait for animation timeout (250ms)
    await vi.advanceTimersByTimeAsync(300);
    // localStorage should have been updated with dismissed ID
    expect(mockStorage["percolator_concept_dismissed"]).toBeTruthy();
    vi.useRealTimers();
  });

  it("shows forced concepts", () => {
    render(<RiskConceptCards forcedConcepts={["funding-rates"]} />);
    expect(screen.getByText("Funding Rates")).toBeTruthy();
    expect(screen.getByText("💸")).toBeTruthy();
  });

  it("returns null when all cards dismissed", () => {
    mockStorage["percolator_concept_dismissed"] = JSON.stringify(["pnl-warmup"]);
    const { container } = render(<RiskConceptCards />);
    expect(container.innerHTML).toBe("");
  });
});
