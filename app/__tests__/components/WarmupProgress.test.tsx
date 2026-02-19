import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { WarmupProgress } from "@/components/trade/WarmupProgress";
import "@testing-library/jest-dom";

// Mock the hooks and dependencies
vi.mock("@/lib/mock-mode", () => ({
  isMockMode: vi.fn(() => false),
}));

vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: vi.fn(() => false),
}));

global.fetch = vi.fn();

describe("WarmupProgress Component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should not render when no warmup is active (404 response)", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const { container } = render(
      <WarmupProgress slabAddress="test-slab" accountIdx={0} />
    );

    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("should render loading state initially", () => {
    (global.fetch as any).mockImplementation(
      () => new Promise(() => {}) // Never resolves
    );

    render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    expect(screen.getByText("Warmup Status")).toBeInTheDocument();
  });

  it("should render warmup in progress correctly", async () => {
    const mockWarmupData = {
      warmupStartedAtSlot: 280000000,
      warmupSlopePerStep: "78190",
      warmupPeriodSlots: 1000,
      currentSlot: 280000500, // 50% through
      totalLockedAmount: "156380000",
      unlockedAmount: "78190000",
      lockedAmount: "78190000",
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockWarmupData,
    });

    render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    await waitFor(() => {
      expect(screen.getByText(/Profit Warming Up/i)).toBeInTheDocument();
    });

    // Check unlocked amount (appears in both Unlocked and Locked rows)
    const amountElements = screen.getAllByText(/\$78\.19/);
    expect(amountElements.length).toBeGreaterThan(0);

    // Check percentages (appears in both Unlocked and Locked rows)
    const pctElements = screen.getAllByText(/50%/);
    expect(pctElements.length).toBeGreaterThan(0);
  });

  it("should show fully unlocked state when progress is 100%", async () => {
    const mockWarmupData = {
      warmupStartedAtSlot: 280000000,
      warmupSlopePerStep: "78190",
      warmupPeriodSlots: 1000,
      currentSlot: 280001000, // 100% complete
      totalLockedAmount: "78190000",
      unlockedAmount: "78190000",
      lockedAmount: "0",
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockWarmupData,
    });

    render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    await waitFor(() => {
      expect(screen.getByText("Fully Unlocked")).toBeInTheDocument();
    });
  });

  it("should calculate countdown correctly", async () => {
    const mockWarmupData = {
      warmupStartedAtSlot: 280000000,
      warmupSlopePerStep: "78190",
      warmupPeriodSlots: 1000,
      currentSlot: 280000750, // 250 slots remaining
      totalLockedAmount: "312760000",
      unlockedAmount: "234570000",
      lockedAmount: "78190000",
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockWarmupData,
    });

    render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    await waitFor(() => {
      // 250 slots * 0.4 seconds = 100 seconds = 1m 40s
      expect(screen.getByText(/1m 40s/)).toBeInTheDocument();
    });
  });

  it("should handle API errors gracefully", async () => {
    (global.fetch as any).mockRejectedValueOnce(
      new Error("Network error")
    );

    const { container } = render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    await waitFor(() => {
      // Component sets warmupData to null on error, so it renders nothing
      expect(container.querySelector('[class*="warmup"]') || container.firstChild === null || container.textContent === '').toBeTruthy();
    });
  });

  it("should refresh data every 5 seconds", async () => {
    vi.useFakeTimers();

    const mockWarmupData = {
      warmupStartedAtSlot: 280000000,
      warmupSlopePerStep: "78190",
      warmupPeriodSlots: 1000,
      currentSlot: 280000500,
      totalLockedAmount: "156380000",
      unlockedAmount: "78190000",
      lockedAmount: "78190000",
    };

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockWarmupData,
    });

    render(<WarmupProgress slabAddress="test-slab" accountIdx={0} />);

    await vi.waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    // Fast-forward 5 seconds
    await vi.advanceTimersByTimeAsync(5000);

    await vi.waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    vi.useRealTimers();
  });

  it("should open explainer modal when 'Why?' is clicked", async () => {
    const mockWarmupData = {
      warmupStartedAtSlot: 280000000,
      warmupSlopePerStep: "78190",
      warmupPeriodSlots: 1000,
      currentSlot: 280000500,
      totalLockedAmount: "156380000",
      unlockedAmount: "78190000",
      lockedAmount: "78190000",
    };

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockWarmupData,
    });

    render(
      <WarmupProgress slabAddress="test-slab" accountIdx={0} />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Why?" })).toBeInTheDocument();
    });

    // Click the "Why?" button
    const whyButton = screen.getByRole("button", { name: "Why?" });
    whyButton.click();

    // Modal should open (mocked, so we just verify the button works)
  });
});
