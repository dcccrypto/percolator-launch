import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChartStyleMenu } from "@/components/trade/ChartStyleMenu";
import { CHART_STYLE_DISPLAY_ORDER, CHART_STYLE_LABELS } from "@/lib/chart-style";

describe("ChartStyleMenu", () => {
  it("renders the active style's label in the trigger when closed", () => {
    render(<ChartStyleMenu value="candle-solid" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Candle \(Solid\)/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
  });

  it("toggles open and closed when the trigger is clicked", () => {
    render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /^Line/i });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders every style option in CHART_STYLE_DISPLAY_ORDER when open", () => {
    render(<ChartStyleMenu value="line" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Line/i }));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(CHART_STYLE_DISPLAY_ORDER.length);
    options.forEach((option, i) => {
      expect(option).toHaveTextContent(CHART_STYLE_LABELS[CHART_STYLE_DISPLAY_ORDER[i]]);
    });
  });

  it("marks the active option with aria-selected=true and the rest with false", () => {
    render(<ChartStyleMenu value="bar" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Bar \(OHLC\)/i }));

    const options = screen.getAllByRole("option");
    const activeOptions = options.filter((o) => o.getAttribute("aria-selected") === "true");
    expect(activeOptions).toHaveLength(1);
    expect(activeOptions[0]).toHaveTextContent("Bar (OHLC)");
  });

  it("calls onChange with the selected style and closes when an option is clicked", () => {
    const onChange = vi.fn();
    render(<ChartStyleMenu value="line" onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: /^Line/i });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("option", { name: /Candle \(Hollow\)$/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("candle-hollow");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when Escape is pressed", () => {
    render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /^Line/i });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when a mousedown occurs outside the component", () => {
    render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /^Line/i });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides the listbox panel from assistive tech when closed", () => {
    // The component sets `aria-hidden={!open || undefined}` so the closed
    // panel is removed from the AT tree. If a future change drops that
    // attribute, screen-reader users would announce stale options.
    const { container } = render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    expect(listbox?.getAttribute("aria-hidden")).toBe("true");
  });

  it("flips option tabIndex between 0 (open) and -1 (closed) so closed options are non-tabbable", () => {
    // Without this, Tab would land on hidden options when the menu is
    // closed — breaking the listbox contract.
    const { container } = render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const closedOptions = container.querySelectorAll('[role="option"]');
    closedOptions.forEach((o) => expect(o.getAttribute("tabindex")).toBe("-1"));

    fireEvent.click(screen.getByRole("button", { name: /^Line/i }));

    const openOptions = container.querySelectorAll('[role="option"]');
    openOptions.forEach((o) => expect(o.getAttribute("tabindex")).toBe("0"));
  });

  it("does not close when a mousedown occurs inside the component", () => {
    render(<ChartStyleMenu value="line" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /^Line/i });
    fireEvent.click(trigger);

    // Mousedown on an option (still inside the component) must NOT trigger
    // the outside-click handler — only the option's onClick should fire.
    const option = screen.getByRole("option", { name: /^Area/i });
    fireEvent.mouseDown(option);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});
