import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

// Mock fetch for stats
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ entries: [] }),
}));

import { SimulatorHero } from "@/app/simulate/components/SimulatorHero";

describe("SimulatorHero", () => {
  it("renders heading text", () => {
    render(<SimulatorHero />);
    expect(screen.getByText(/zero risk/i)).toBeTruthy();
    expect(screen.getByText(/Learn everything/i)).toBeTruthy();
  });

  it("renders description text about simulated funds", () => {
    render(<SimulatorHero />);
    expect(screen.getByText(/simulated funds/i)).toBeTruthy();
  });

  it("renders Try the Risk Engine CTA", () => {
    render(<SimulatorHero />);
    expect(screen.getByText(/Try the Risk Engine/i)).toBeTruthy();
  });

  it("renders badge", () => {
    render(<SimulatorHero />);
    expect(screen.getAllByText(/Risk Engine Simulator/i).length).toBeGreaterThanOrEqual(1);
  });

  it("renders animated chart area (SVG present)", () => {
    render(<SimulatorHero />);
    const svgs = document.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThan(0);
  });

  it("renders devnet SOL link", () => {
    render(<SimulatorHero />);
    expect(screen.getByText(/devnet SOL/i)).toBeTruthy();
  });

  it("renders stat labels", () => {
    render(<SimulatorHero />);
    expect(screen.getByText("Traders")).toBeTruthy();
    expect(screen.getByText("Trades")).toBeTruthy();
  });
});
