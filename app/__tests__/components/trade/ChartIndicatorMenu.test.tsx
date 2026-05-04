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
    const smaSwatch = screen.getByTestId("indicator-swatch-sma");
    expect(smaSwatch).toBeInTheDocument();
    expect(smaSwatch).toHaveStyle({ backgroundColor: "#9945FF" });
    // Swatch is decorative — aria-hidden so screen readers ignore the hex.
    expect(smaSwatch).toHaveAttribute("aria-hidden", "true");
    // EMA is OFF in this test — no swatch for it.
    expect(screen.queryByTestId("indicator-swatch-ema")).toBeNull();
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

  // Toggle-ON path is structurally identical across all 5 kinds (one map
  // over ALL_INDICATOR_KINDS). Each label only resolves to its own kind
  // if the closure captures `kind` correctly inside the .map — a bug that
  // hardcoded "sma" would slip past the SMA-only test above.
  it.each([
    ["Exponential Moving Average", "ema"],
    ["Bollinger Bands", "bollinger"],
    ["Relative Strength Index", "rsi"],
    ["MACD", "macd"],
  ])("toggling an OFF row for %s adds the matching kind", (label, kind) => {
    const addIndicator = vi.fn();
    render(
      <ChartIndicatorMenu {...noopProps} addIndicator={addIndicator} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(label, "i"), pressed: false }),
    );
    expect(addIndicator).toHaveBeenCalledWith(kind);
  });

  it("Bollinger StdDev input commits with the stdDev key (not period)", () => {
    const updateIndicator = vi.fn();
    const bb: IndicatorConfig = {
      id: "abc",
      kind: "bollinger",
      period: 20,
      stdDev: 2,
      color: "#22D3EE",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[bb]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));
    const stdDevInput = screen.getByLabelText("StdDev");
    fireEvent.change(stdDevInput, { target: { value: "2.5" } });
    fireEvent.blur(stdDevInput);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { stdDev: 2.5 });
  });

  it("MACD slow / signal inputs commit with their own keys", () => {
    const updateIndicator = vi.fn();
    const m: IndicatorConfig = {
      id: "abc",
      kind: "macd",
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      color: "#F59E0B",
    };
    render(
      <ChartIndicatorMenu
        {...noopProps}
        indicators={[m]}
        updateIndicator={updateIndicator}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Indicators/i }));

    const slow = screen.getByLabelText("Slow");
    fireEvent.change(slow, { target: { value: "30" } });
    fireEvent.blur(slow);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { slowPeriod: 30 });

    const signal = screen.getByLabelText("Signal");
    fireEvent.change(signal, { target: { value: "12" } });
    fireEvent.blur(signal);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { signalPeriod: 12 });
  });

  it("clamps below-min input up to min on commit", () => {
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

    // SMA period min is 2.
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    expect(updateIndicator).toHaveBeenCalledWith("abc", { period: 2 });
    expect(input).toHaveValue(2);
  });

  it("treats an empty input as no-change (does not call onChange with 0/min)", () => {
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

    // Cleared field — Number("") is 0 which would clamp to min=2 if the
    // empty-string guard were removed.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(updateIndicator).not.toHaveBeenCalled();
    expect(input).toHaveValue(20);
  });

  it("Clear all keeps the menu open so the user can immediately re-add", () => {
    const sma: IndicatorConfig = {
      id: "abc",
      kind: "sma",
      period: 20,
      color: "#9945FF",
    };
    render(<ChartIndicatorMenu {...noopProps} indicators={[sma]} clearAll={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Indicators/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
