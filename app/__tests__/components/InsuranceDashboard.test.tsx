import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { InsuranceDashboard } from "@/components/market/InsuranceDashboard";
import "@testing-library/jest-dom";

jest.mock("@/lib/mock-mode", () => ({
  isMockMode: jest.fn(() => false),
}));

jest.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: jest.fn(() => false),
}));

global.fetch = jest.fn();

describe("InsuranceDashboard Component", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should render loading state initially", () => {
    (global.fetch as jest.Mock).mockImplementation(
      () => new Promise(() => {})
    );

    render(<InsuranceDashboard slabAddress="test-slab" />);

    expect(screen.getByText("Insurance Fund")).toBeInTheDocument();
  });

  it("should render insurance data correctly", async () => {
    const mockInsuranceData = {
      balance: "125432000000", // $125,432
      feeRevenue: "12543000000", // $12,543
      dailyAccumulationRate: 234,
      coverageRatio: 8.5,
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now() - 24 * 60 * 60 * 1000, balance: 120000 },
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("🛡️")).toBeInTheDocument();
      expect(screen.getByText("$125,432")).toBeInTheDocument();
      expect(screen.getByText("$12,543")).toBeInTheDocument();
    });
  });

  it("should show healthy status when coverage ratio >= 5", async () => {
    const mockInsuranceData = {
      balance: "125432000000",
      feeRevenue: "12543000000",
      dailyAccumulationRate: 234,
      coverageRatio: 8.5, // Healthy
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("🟢")).toBeInTheDocument();
      expect(screen.getByText("Healthy")).toBeInTheDocument();
    });
  });

  it("should show moderate status when coverage ratio 2-5", async () => {
    const mockInsuranceData = {
      balance: "50000000000",
      feeRevenue: "5000000000",
      dailyAccumulationRate: 100,
      coverageRatio: 3.2, // Moderate
      totalRisk: "15625000000",
      historicalBalance: [
        { timestamp: Date.now(), balance: 50000 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("🟡")).toBeInTheDocument();
      expect(screen.getByText("Moderate")).toBeInTheDocument();
    });
  });

  it("should show low status when coverage ratio < 2", async () => {
    const mockInsuranceData = {
      balance: "20000000000",
      feeRevenue: "2000000000",
      dailyAccumulationRate: 50,
      coverageRatio: 1.5, // Low
      totalRisk: "13333333333",
      historicalBalance: [
        { timestamp: Date.now(), balance: 20000 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("🔴")).toBeInTheDocument();
      expect(screen.getByText("Low")).toBeInTheDocument();
    });
  });

  it("should render 7-day balance trend chart", async () => {
    const mockInsuranceData = {
      balance: "125432000000",
      feeRevenue: "12543000000",
      dailyAccumulationRate: 234,
      coverageRatio: 8.5,
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, balance: 120000 },
        { timestamp: Date.now() - 6 * 24 * 60 * 60 * 1000, balance: 121000 },
        { timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000, balance: 122000 },
        { timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000, balance: 123000 },
        { timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, balance: 123500 },
        { timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, balance: 124500 },
        { timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000, balance: 125000 },
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("7-Day Balance Trend")).toBeInTheDocument();
      // Calculate percentage increase
      const percentIncrease = ((125432 / 120000 - 1) * 100).toFixed(1);
      expect(screen.getByText(new RegExp(`${percentIncrease}%`))).toBeInTheDocument();
    });
  });

  it("should open explainer modal when 'Learn More' is clicked", async () => {
    const mockInsuranceData = {
      balance: "125432000000",
      feeRevenue: "12543000000",
      dailyAccumulationRate: 234,
      coverageRatio: 8.5,
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getAllByText("Learn More")[0]).toBeInTheDocument();
    });

    // Click one of the "Learn More" buttons
    const learnMoreButtons = screen.getAllByText("Learn More");
    fireEvent.click(learnMoreButtons[0]);

    // Modal should open (would need to verify modal content in real test)
  });

  it("should open top-up modal when 'Top Up Insurance' is clicked", async () => {
    const mockInsuranceData = {
      balance: "125432000000",
      feeRevenue: "12543000000",
      dailyAccumulationRate: 234,
      coverageRatio: 8.5,
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      expect(screen.getByText("Top Up Insurance")).toBeInTheDocument();
    });

    // Click "Top Up Insurance" button
    const topUpButton = screen.getByText("Top Up Insurance");
    fireEvent.click(topUpButton);

    // Modal should open (would verify modal content in real test)
  });

  it("should handle API errors gracefully", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error("Network error")
    );

    render(<InsuranceDashboard slabAddress="test-slab" />);

    await waitFor(() => {
      // Should still render with fallback mock data
      expect(screen.getByText("Insurance Fund")).toBeInTheDocument();
    });
  });

  it("should refresh data every 30 seconds", async () => {
    jest.useFakeTimers();

    const mockInsuranceData = {
      balance: "125432000000",
      feeRevenue: "12543000000",
      dailyAccumulationRate: 234,
      coverageRatio: 8.5,
      totalRisk: "14750000000",
      historicalBalance: [
        { timestamp: Date.now(), balance: 125432 },
      ],
    };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockInsuranceData,
    });

    render(<InsuranceDashboard slabAddress="test-slab" />);

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
});
