import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChartIndicatorMenu } from "@/components/trade/ChartIndicatorMenu";
import type { IndicatorConfig } from "@/lib/indicator-registry";

const noopProps = {
  indicators: [] as IndicatorConfig[],
  addIndicator: () => {},
  removeIndicator: () => {},
  updateIndicator: () => {},
  clearAll: () => {},
};

describe("ChartIndicatorMenu", () => {
  it("renders the f(x) trigger with aria-haspopup", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    expect(trigger).toHaveTextContent("f(x)");
    expect(trigger).toHaveAttribute("aria-haspopup", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles open / closed when the trigger is clicked", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders one row per indicator kind when open", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    expect(screen.getByText("Simple Moving Average")).toBeInTheDocument();
    expect(screen.getByText("Exponential Moving Average")).toBeInTheDocument();
    expect(screen.getByText("Bollinger Bands")).toBeInTheDocument();
    expect(screen.getByText("Relative Strength Index")).toBeInTheDocument();
    expect(screen.getByText("MACD")).toBeInTheDocument();
  });

  it("toggling an OFF row calls addIndicator with the kind", () => {
    const addIndicator = vi.fn();
    render(
      <ChartIndicatorMenu {...noopProps} addIndicator={addIndicator} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Simple Moving Average/i, pressed: false }),
    );
    expect(addIndicator).toHaveBeenCalledWith("sma");
    expect(addIndicator).toHaveBeenCalledTimes(1);
  });

  it("toggling an ON row calls removeIndicator with the matching id", () => {
    const removeIndicator = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        removeIndicator={removeIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Simple Moving Average/i, pressed: true }),
    );
    expect(removeIndicator).toHaveBeenCalledWith("abc");
  });

  it("shows a colour swatch only for enabled indicators", () => {
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(<ChartIndicatorMenu {...noopProps} indicators={[sma]} />);
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    expect(
      screen.getByLabelText(/Indicator colour #9945FF/i),
    ).toBeInTheDocument();
    // EMA is OFF in this test — no swatch for it.
    const emaRow = screen.getByText("Exponential Moving Average").parentElement!
      .parentElement!;
    expect(
      emaRow.querySelector('[aria-label*="Indicator colour"]'),
    ).toBeNull();
  });

  it("Bollinger row shows period AND stdDev inputs when enabled", () => {
    const bb: IndicatorConfig = {
      id: "abc",
      kind: "bollinger",
      period: 20,
      stdDev: 2,
      color: "#22D3EE",
    };
    render(<ChartIndicatorMenu {...noopProps} indicators={[bb]} />);
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    expect(screen.getByLabelText("Period")).toHaveValue(20);
    expect(screen.getByLabelText("StdDev")).toHaveValue(2);
  });

  it("MACD row shows fast / slow / signal inputs when enabled", () => {
    const m: IndicatorConfig = {
      id: "abc",
      kind: "macd",
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      color: "#F59E0B",
    };
    render(<ChartIndicatorMenu {...noopProps} indicators={[m]} />);
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    expect(screen.getByLabelText("Fast")).toHaveValue(12);
    expect(screen.getByLabelText("Slow")).toHaveValue(26);
    expect(screen.getByLabelText("Signal")).toHaveValue(9);
  });

  it("commits a number-input change on blur (not on every keystroke)", () => {
    const updateIndicator = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const input = screen.getByLabelText("Period");

    // Typing should NOT call updateIndicator yet.
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.change(input, { target: { value: "50" } });
    expect(updateIndicator).not.toHaveBeenCalled();

    // Blur commits.
    fireEvent.blur(input);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { period: 50 });
  });

  it("Enter key commits a number-input change", () => {
    const updateIndicator = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const input = screen.getByLabelText("Period");

    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateIndicator).toHaveBeenCalledWith("abc", { period: 100 });
  });

  it("clamps out-of-range input to [min, max] on commit", () => {
    const updateIndicator = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const input = screen.getByLabelText("Period");

    // SMA period range is [2, 500]
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { period: 500 });
    expect(input).toHaveValue(500);
  });

  it("reverts to last valid value when given non-numeric garbage", () => {
    const updateIndicator = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const input = screen.getByLabelText("Period");

    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(updateIndicator).not.toHaveBeenCalled();
    expect(input).toHaveValue(20); // reverted
  });

  it("Clear all is disabled when no indicators are active", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const clearAll = screen.getByRole("button", { name: /Clear all/i });
    expect(clearAll).toBeDisabled();
  });

  it("Clear all calls clearAll() when active", () => {
    const clearAll = vi.fn();
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[sma]}
        clearAll={clearAll}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    fireEvent.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(clearAll).toHaveBeenCalledTimes(1);
  });

  it("closes when Escape is pressed (and focus is NOT in an input)", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("does NOT close when Escape is pressed while focus is in a number input", () => {
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(<ChartIndicatorMenu {...noopProps} indicators={[sma]} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("Period");
    input.focus();

    fireEvent.keyDown(document, { key: "Escape" });
    // Menu should stay open; user might be editing.
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes when a mousedown occurs outside the menu", () => {
    render(<ChartIndicatorMenu {...noopProps} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
