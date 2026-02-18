import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock all child components to isolate dashboard rendering
vi.mock("@/components/ui/ErrorBoundary", () => ({
  ErrorBoundary: ({ children, label }: any) => <div data-testid={`eb-${label}`}>{children}</div>,
}));
vi.mock("@/components/trade/EngineHealthCard", () => ({
  EngineHealthCard: () => <div>EngineHealth</div>,
}));
vi.mock("@/components/trade/FundingRateCard", () => ({
  FundingRateCard: ({ slabAddress }: any) => <div>FundingRate:{slabAddress}</div>,
}));
vi.mock("@/components/trade/InsuranceLPPanel", () => ({
  InsuranceLPPanel: () => <div>InsuranceLP</div>,
}));
vi.mock("@/components/trade/LiquidationAnalytics", () => ({
  LiquidationAnalytics: () => <div>LiquidationAnalytics</div>,
}));
vi.mock("@/components/trade/CrankHealthCard", () => ({
  CrankHealthCard: () => <div>CrankHealth</div>,
}));
vi.mock("@/components/trade/SystemCapitalCard", () => ({
  SystemCapitalCard: () => <div>SystemCapital</div>,
}));

import { SimRiskDashboard } from "@/app/simulate/components/SimRiskDashboard";

describe("SimRiskDashboard", () => {
  it("renders section header", () => {
    render(<SimRiskDashboard slabAddress="test-slab" />);
    expect(screen.getByText(/RISK DASHBOARD/i)).toBeTruthy();
  });

  it("renders all sub-section labels", () => {
    render(<SimRiskDashboard slabAddress="test-slab" />);
    expect(screen.getByText("Engine Health")).toBeTruthy();
    expect(screen.getByText("Funding Rate")).toBeTruthy();
    expect(screen.getByText("Crank Health")).toBeTruthy();
    expect(screen.getByText("System Capital")).toBeTruthy();
    expect(screen.getByText("Liquidation Analytics")).toBeTruthy();
    expect(screen.getByText("Insurance Fund")).toBeTruthy();
  });

  it("renders all child components", () => {
    render(<SimRiskDashboard slabAddress="test-slab" />);
    expect(screen.getByText("EngineHealth")).toBeTruthy();
    expect(screen.getByText("FundingRate:test-slab")).toBeTruthy();
    expect(screen.getByText("CrankHealth")).toBeTruthy();
    expect(screen.getByText("SystemCapital")).toBeTruthy();
    expect(screen.getByText("LiquidationAnalytics")).toBeTruthy();
    expect(screen.getByText("InsuranceLP")).toBeTruthy();
  });

  it("passes slab address to FundingRateCard", () => {
    render(<SimRiskDashboard slabAddress="my-slab-123" />);
    expect(screen.getByText("FundingRate:my-slab-123")).toBeTruthy();
  });

  it("wraps each card in ErrorBoundary", () => {
    render(<SimRiskDashboard slabAddress="test-slab" />);
    expect(screen.getByTestId("eb-EngineHealthCard")).toBeTruthy();
    expect(screen.getByTestId("eb-FundingRateCard")).toBeTruthy();
    expect(screen.getByTestId("eb-CrankHealthCard")).toBeTruthy();
    expect(screen.getByTestId("eb-SystemCapitalCard")).toBeTruthy();
    expect(screen.getByTestId("eb-LiquidationAnalytics")).toBeTruthy();
    expect(screen.getByTestId("eb-InsuranceLPPanel")).toBeTruthy();
  });
});
