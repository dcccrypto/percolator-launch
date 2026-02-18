import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("../../../app/simulate/components/GuidedWalkthrough", () => ({
  TourHelpButton: () => <button>Help</button>,
}));

import { SimulatorHeader } from "@/app/simulate/components/SimulatorHeader";

const MARKETS = [
  { key: "SOL/USD", name: "SIM-SOL/USD" },
  { key: "BTC/USD", name: "SIM-BTC/USD" },
  { key: "ETH/USD", name: "SIM-ETH/USD" },
];

describe("SimulatorHeader", () => {
  const onMarketChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title and subtitle", () => {
    render(<SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} />);
    expect(screen.getByText("Risk Engine Simulator")).toBeTruthy();
    expect(screen.getByText(/Trade on real Percolator/)).toBeTruthy();
  });

  it("renders all market tabs", () => {
    render(<SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} />);
    expect(screen.getByText("SIM-SOL/USD")).toBeTruthy();
    expect(screen.getByText("SIM-BTC/USD")).toBeTruthy();
    expect(screen.getByText("SIM-ETH/USD")).toBeTruthy();
  });

  it("calls onMarketChange when tab clicked", () => {
    render(<SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} />);
    fireEvent.click(screen.getByText("SIM-BTC/USD"));
    expect(onMarketChange).toHaveBeenCalledWith("BTC/USD");
  });

  it("shows devnet badge", () => {
    render(<SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} />);
    expect(screen.getByText("Devnet")).toBeTruthy();
  });

  it("shows Get simUSDC link", () => {
    render(<SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} />);
    expect(screen.getByText("Get simUSDC")).toBeTruthy();
  });

  it("shows active scenario badge when provided", () => {
    render(
      <SimulatorHeader
        markets={MARKETS}
        selectedMarket="SOL/USD"
        onMarketChange={onMarketChange}
        activeScenario="flash-crash"
      />
    );
    expect(screen.getByText("Flash Crash")).toBeTruthy();
    expect(screen.getByText("📉")).toBeTruthy();
  });

  it("does not show scenario badge when null", () => {
    render(
      <SimulatorHeader
        markets={MARKETS}
        selectedMarket="SOL/USD"
        onMarketChange={onMarketChange}
        activeScenario={null}
      />
    );
    expect(screen.queryByText("Flash Crash")).toBeNull();
  });

  it("shows different scenario icons", () => {
    const { rerender } = render(
      <SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} activeScenario="short-squeeze" />
    );
    expect(screen.getByText("Short Squeeze")).toBeTruthy();
    expect(screen.getByText("🚀")).toBeTruthy();

    rerender(
      <SimulatorHeader markets={MARKETS} selectedMarket="SOL/USD" onMarketChange={onMarketChange} activeScenario="black-swan" />
    );
    expect(screen.getByText("Black Swan")).toBeTruthy();
    expect(screen.getByText("🦢")).toBeTruthy();
  });
});
