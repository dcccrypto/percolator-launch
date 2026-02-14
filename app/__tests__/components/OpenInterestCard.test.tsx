import { render, screen, waitFor } from "@testing-library/react";
import { OpenInterestCard } from "@/components/market/OpenInterestCard";
import "@testing-library/jest-dom";

jest.mock("@/lib/mock-mode", () => ({
  isMockMode: jest.fn(() => false),
}));

jest.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: jest.fn(() => false),
}));

global.fetch = jest.fn();

describe("OpenInterestCard Component", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render loading state initially", () => {
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise(() => {})
    );

    render(<OpenInterestCard slabAddress="test-slab" />);

    expect(screen.getByText("Open Interest")).toBeInTheDocument();
  });

  it("should render OI data correctly", async () => {
    const mockOiData = {
      totalOi: "5234123000000", // $5,234,123
      longOi: "2850000000000", // $2,850,000
      shortOi: "2384123000000", // $2,384,123
      netLpPosition: "465877000000", // +$465,877
      historicalOi: [
        {
          timestamp: Date.now() - 24 * 60 * 60 * 1000,
          totalOi: 5000000,
          longOi: 2600000,
          shortOi: 2400000,
        },
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("📊")).toBeInTheDocument();
      expect(screen.getByText("$5,234,123")).toBeInTheDocument();
    });
  });

  it("should calculate long/short percentages correctly", async () => {
    const mockOiData = {
      totalOi: "5234123000000", // $5,234,123
      longOi: "2850000000000", // $2,850,000 (54.5%)
      shortOi: "2384123000000", // $2,384,123 (45.5%)
      netLpPosition: "465877000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      // Long percentage
      expect(screen.getByText(/54\.5%/)).toBeInTheDocument();
      // Short percentage
      expect(screen.getByText(/45\.5%/)).toBeInTheDocument();
    });
  });

  it("should show balanced imbalance when < 5%", async () => {
    const mockOiData = {
      totalOi: "5000000000000",
      longOi: "2520000000000", // 50.4%
      shortOi: "2480000000000", // 49.6%
      netLpPosition: "40000000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5000000,
          longOi: 2520000,
          shortOi: 2480000,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("Balanced")).toBeInTheDocument();
    });
  });

  it("should show slightly long-heavy when imbalance 5-15%", async () => {
    const mockOiData = {
      totalOi: "5234123000000",
      longOi: "2850000000000", // 54.5% (9% imbalance)
      shortOi: "2384123000000", // 45.5%
      netLpPosition: "465877000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("Slightly long-heavy")).toBeInTheDocument();
    });
  });

  it("should show heavily long-heavy when imbalance > 15%", async () => {
    const mockOiData = {
      totalOi: "5000000000000",
      longOi: "3000000000000", // 60%
      shortOi: "2000000000000", // 40% (20% imbalance)
      netLpPosition: "1000000000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5000000,
          longOi: 3000000,
          shortOi: 2000000,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("Heavily long-heavy")).toBeInTheDocument();
    });
  });

  it("should show LP position correctly for long positions", async () => {
    const mockOiData = {
      totalOi: "5234123000000",
      longOi: "2850000000000",
      shortOi: "2384123000000",
      netLpPosition: "465877000000", // +$465,877 (long)
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("+$465,877")).toBeInTheDocument();
      expect(screen.getByText("(long)")).toBeInTheDocument();
    });
  });

  it("should show LP position correctly for short positions", async () => {
    const mockOiData = {
      totalOi: "5234123000000",
      longOi: "2384123000000", // Reversed
      shortOi: "2850000000000",
      netLpPosition: "-465877000000", // -$465,877 (short)
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2384123,
          shortOi: 2850000,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("-$465,877")).toBeInTheDocument();
      expect(screen.getByText("(short)")).toBeInTheDocument();
    });
  });

  it("should render 24h OI history chart", async () => {
    const mockOiData = {
      totalOi: "5234123000000",
      longOi: "2850000000000",
      shortOi: "2384123000000",
      netLpPosition: "465877000000",
      historicalOi: [
        {
          timestamp: Date.now() - 24 * 60 * 60 * 1000,
          totalOi: 5000000,
          longOi: 2600000,
          shortOi: 2400000,
        },
        {
          timestamp: Date.now() - 12 * 60 * 60 * 1000,
          totalOi: 5100000,
          longOi: 2700000,
          shortOi: 2400000,
        },
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("24h OI History")).toBeInTheDocument();
      // Calculate percentage change
      const percentChange = ((5234123 / 5000000 - 1) * 100).toFixed(1);
      expect(screen.getByText(new RegExp(`${percentChange}%`))).toBeInTheDocument();
    });
  });

  it("should handle API errors gracefully", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error("Network error")
    );

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      // Should still render with fallback mock data
      expect(screen.getByText("Open Interest")).toBeInTheDocument();
    });
  });

  it("should refresh data every 30 seconds", async () => {
    jest.useFakeTimers();

    const mockOiData = {
      totalOi: "5234123000000",
      longOi: "2850000000000",
      shortOi: "2384123000000",
      netLpPosition: "465877000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 5234123,
          longOi: 2850000,
          shortOi: 2384123,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockOiData,
    });

    render(<OpenInterestCard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    // Fast-forward 30 seconds
    jest.advanceTimersByTime(30000);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    jest.useRealTimers();
  });

  it("should display progress bars with correct widths", async () => {
    const mockOiData = {
      totalOi: "10000000000000",
      longOi: "6000000000000", // 60%
      shortOi: "4000000000000", // 40%
      netLpPosition: "2000000000000",
      historicalOi: [
        {
          timestamp: Date.now(),
          totalOi: 10000000,
          longOi: 6000000,
          shortOi: 4000000,
        },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockOiData,
    });

    const { container } = render(
      <OpenInterestCard slabAddress="test-slab" />
    );

    await waitFor(() => {
      // Check that progress bars are rendered
      const progressBars = container.querySelectorAll(
        '[style*="width: 60%"], [style*="width: 40%"]'
      );
      expect(progressBars.length).toBeGreaterThan(0);
    });
  });
});
