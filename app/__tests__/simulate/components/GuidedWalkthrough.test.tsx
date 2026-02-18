import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock localStorage
const mockStorage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mockStorage[k] || null,
  setItem: (k: string, v: string) => { mockStorage[k] = v; },
  removeItem: (k: string) => { delete mockStorage[k]; },
});

import { GuidedWalkthrough, TourHelpButton } from "@/app/simulate/components/GuidedWalkthrough";

describe("GuidedWalkthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
  });

  it("renders first step on mount (auto-starts)", () => {
    render(<GuidedWalkthrough />);
    expect(screen.getByText("Connect Your Wallet")).toBeTruthy();
  });

  it("shows step counter (Step 1 of 7)", () => {
    render(<GuidedWalkthrough />);
    expect(screen.getByText(/Step 1 of 7/i)).toBeTruthy();
  });

  it("shows wallet icon on first step", () => {
    render(<GuidedWalkthrough />);
    expect(screen.getByText("👛")).toBeTruthy();
  });

  it("has action button to advance steps", () => {
    render(<GuidedWalkthrough />);
    // Step 1 action is "Connect wallet →"
    const actionBtn = screen.getByText(/Connect wallet/i);
    expect(actionBtn).toBeTruthy();
    fireEvent.click(actionBtn);
    // Should advance to step 2
    expect(screen.getByText("Get simUSDC")).toBeTruthy();
    expect(screen.getByText(/Step 2 of 7/i)).toBeTruthy();
  });

  it("navigates through steps", () => {
    render(<GuidedWalkthrough />);
    // Step 1 → 2 (click action button which says "Connect wallet →")
    fireEvent.click(screen.getByText(/Connect wallet →/i));
    expect(screen.getByText("Get simUSDC")).toBeTruthy();
    
    // Step 2 → 3 (action button says "Get simUSDC →")
    fireEvent.click(screen.getByText(/Get simUSDC →/i));
    expect(screen.getByText("Open a Position")).toBeTruthy();
  });

  it("has back button from step 2+", () => {
    render(<GuidedWalkthrough />);
    // No back button on step 1
    expect(screen.queryByText(/← Back/i)).toBeNull();
    
    // Go to step 2
    fireEvent.click(screen.getByText(/Connect wallet/i));
    expect(screen.getByText(/← Back/i)).toBeTruthy();
    
    // Go back
    fireEvent.click(screen.getByText(/← Back/i));
    expect(screen.getByText("Connect Your Wallet")).toBeTruthy();
  });

  it("has Skip button to dismiss tour", () => {
    render(<GuidedWalkthrough />);
    const skipBtn = screen.getByText(/Skip tour/i);
    expect(skipBtn).toBeTruthy();
    fireEvent.click(skipBtn);
    // After skip, tour should be gone
    expect(screen.queryByText("Connect Your Wallet")).toBeNull();
    // Should have saved completion to localStorage
    expect(mockStorage["percolator_tour_completed"]).toBe("true");
  });

  it("does not render if tour already completed", () => {
    mockStorage["percolator_tour_completed"] = "true";
    render(<GuidedWalkthrough />);
    expect(screen.queryByText("Connect Your Wallet")).toBeNull();
  });

  it("resumes from saved step", () => {
    mockStorage["percolator_tour_step"] = "3";
    render(<GuidedWalkthrough />);
    expect(screen.getByText("Open a Position")).toBeTruthy();
    expect(screen.getByText(/Step 3 of 7/i)).toBeTruthy();
  });
});

describe("TourHelpButton", () => {
  it("renders a ? button", () => {
    render(<TourHelpButton />);
    const btn = screen.getByRole("button");
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain("?");
  });

  it("dispatches percolator:openTour event on click", () => {
    const handler = vi.fn();
    window.addEventListener("percolator:openTour", handler);
    render(<TourHelpButton />);
    fireEvent.click(screen.getByRole("button"));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener("percolator:openTour", handler);
  });
});
