import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PerpSeriesToggle } from "@/components/trade/perp/PerpSeriesToggle";
import { PerpChartHeader } from "@/components/trade/perp/PerpChartHeader";
import type { PerpHeaderStats } from "@/hooks/usePerpHeaderStats";

const stats = (over: Partial<PerpHeaderStats> = {}): PerpHeaderStats => ({
  change: { pct: 3.2, partial: false }, volume24hUsd: 1_250_000, oiUsd: 42_300, funding: { hourlyPct: 0, enabled: false }, ...over,
});

describe("PerpSeriesToggle", () => {
  it("is a radio group with the current series checked, and clicking selects", () => {
    const onChange = vi.fn();
    render(<PerpSeriesToggle value="mark" onChange={onChange} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Mark", "Oracle", "Last"]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
    fireEvent.click(radios[2]);
    expect(onChange).toHaveBeenCalledWith("last");
  });
  it("arrow keys move the selection and wrap", () => {
    const onChange = vi.fn();
    render(<PerpSeriesToggle value="last" onChange={onChange} />);
    const last = screen.getByRole("radio", { name: "Last" });
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("mark");
    fireEvent.keyDown(last, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("oracle");
  });
  it("explains each source on hover", () => {
    render(<PerpSeriesToggle value="mark" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Oracle" }).getAttribute("title")).toMatch(/raw pool price/i);
  });
});

describe("PerpChartHeader", () => {
  it("shows price, 24h change, volume, OI and funding", () => {
    render(<PerpChartHeader price={0.003461} stats={stats()} live="live" ageSec={0.4} seriesLabel="Mark" />);
    expect(screen.getByTestId("perp-price").textContent).toBe("0.003461");
    expect(screen.getByText("+3.20%")).toBeInTheDocument();
    expect(screen.getByText("$1.25M")).toBeInTheDocument();
    expect(screen.getByText("$42.3K")).toBeInTheDocument();
    expect(screen.getByText("0.0000% / h")).toBeInTheDocument();
    expect(screen.getByText(/Live 0\.4s/)).toBeInTheDocument();
  });
  it("funding off says so; funding on shows the signed hourly rate; unknown is a dash", () => {
    const { rerender } = render(<PerpChartHeader price={1} stats={stats()} live="live" ageSec={1} seriesLabel="Mark" />);
    expect(screen.getByTitle(/funding is off/i)).toBeInTheDocument();
    rerender(<PerpChartHeader price={1} stats={stats({ funding: { hourlyPct: 0.0123, enabled: true } })} live="live" ageSec={1} seriesLabel="Mark" />);
    expect(screen.getByText("+0.0123% / h")).toBeInTheDocument();
    expect(screen.getByTitle(/accrues continuously/i)).toBeInTheDocument();
    rerender(<PerpChartHeader price={1} stats={stats({ funding: null })} live="live" ageSec={1} seriesLabel="Mark" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
  it("marks a partial 24h change and colours losses", () => {
    render(<PerpChartHeader price={1} stats={stats({ change: { pct: -4.5, partial: true } })} live="live" ageSec={1} seriesLabel="Mark" />);
    const el = screen.getByText("-4.50%*");
    expect(el.className).toMatch(/short/);
  });
  it("reports delayed and offline honestly", () => {
    const { rerender } = render(<PerpChartHeader price={1} stats={stats()} live="delayed" ageSec={30} seriesLabel="Mark" />);
    expect(screen.getByText(/Delayed 30s/)).toBeInTheDocument();
    rerender(<PerpChartHeader price={null} stats={stats({ change: null })} live="offline" ageSec={null} seriesLabel="Mark" />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByTestId("perp-price").textContent).toBe("—");
  });
  it("keeps sub-cent memecoin precision in the price", () => {
    render(<PerpChartHeader price={0.000126} stats={stats()} live="live" ageSec={1} seriesLabel="Mark" />);
    expect(screen.getByTestId("perp-price").textContent).toBe("0.0001260");
  });
  it("the 24h chip says which series it is computed from", () => {
    const { rerender } = render(<PerpChartHeader price={1} stats={stats()} live="live" ageSec={1} seriesLabel="Oracle" />);
    expect(screen.getByTitle(/Oracle price/)).toBeInTheDocument();
    rerender(<PerpChartHeader price={1} stats={stats()} live="live" ageSec={1} seriesLabel="Last" />);
    expect(screen.getByTitle(/Last price/)).toBeInTheDocument();
    expect(screen.queryByTitle(/Oracle price/)).toBeNull();
  });
});
