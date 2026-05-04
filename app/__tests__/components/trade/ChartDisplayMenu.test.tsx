import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChartDisplayMenu } from "@/components/trade/ChartDisplayMenu";
import {
  DEFAULT_OVERLAY_PREFS,
  OVERLAY_DISPLAY_ORDER,
  OVERLAY_LABELS,
} from "@/lib/chart-overlays";

const allOn = { ...DEFAULT_OVERLAY_PREFS };

describe("ChartDisplayMenu", () => {
  it("renders a static 'Display' trigger label regardless of pref state", () => {
    render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Display/i });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
  });

  it("toggles open and closed when the trigger is clicked", () => {
    render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Display/i });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders every overlay toggle in OVERLAY_DISPLAY_ORDER when open", () => {
    render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Display/i }));

    for (const key of OVERLAY_DISPLAY_ORDER) {
      expect(
        screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS[key], "i") }),
      ).toBeInTheDocument();
    }
  });

  it("aria-pressed reflects the current value of each overlay pref", () => {
    render(
      <ChartDisplayMenu
        prefs={{ ...DEFAULT_OVERLAY_PREFS, entry: true, liq: false, pnl: true }}
        onToggle={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Display/i }));

    expect(
      screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.entry, "i") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.liq, "i") })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.pnl, "i") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("calls onToggle with the inverted value when a row is clicked", () => {
    const onToggle = vi.fn();
    render(
      <ChartDisplayMenu
        prefs={{ ...DEFAULT_OVERLAY_PREFS, entry: true, liq: false, pnl: true }}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Display/i }));

    // entry is currently true → click should fire onToggle("entry", false)
    fireEvent.click(screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.entry, "i") }));
    expect(onToggle).toHaveBeenLastCalledWith("entry", false);

    // liq is currently false → click should fire onToggle("liq", true)
    fireEvent.click(screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.liq, "i") }));
    expect(onToggle).toHaveBeenLastCalledWith("liq", true);
  });

  it("does NOT close the menu after toggling a row (multi-toggle UX)", () => {
    // Unlike ChartStyleMenu (single-select, click → pick → close), the
    // Display menu is multi-toggle — closing on every click would force the
    // user to reopen the menu for each overlay they want to flip.
    const onToggle = vi.fn();
    render(<ChartDisplayMenu prefs={allOn} onToggle={onToggle} />);
    const trigger = screen.getByRole("button", { name: /Display/i });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(OVERLAY_LABELS.entry, "i") }));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when Escape is pressed", () => {
    render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Display/i });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when a mousedown occurs outside the component", () => {
    render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Display/i });
    fireEvent.click(trigger);

    fireEvent.mouseDown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides the popup container from assistive tech when closed", () => {
    const { container } = render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);
    const popup = container.querySelector('div[aria-hidden="true"]');
    expect(popup).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Display/i }));
    expect(container.querySelector('div[aria-hidden="true"]')).toBeNull();
  });

  it("flips toggle-row tabIndex between 0 (open) and -1 (closed)", () => {
    const { container } = render(<ChartDisplayMenu prefs={allOn} onToggle={() => {}} />);

    // Toggle rows live inside the popup; the trigger button is always tabIndex=0.
    // Filter to the rows by aria-pressed presence (trigger lacks it).
    const closedRows = container.querySelectorAll('button[aria-pressed]');
    closedRows.forEach((r) => expect(r.getAttribute("tabindex")).toBe("-1"));

    fireEvent.click(screen.getByRole("button", { name: /Display/i }));

    const openRows = container.querySelectorAll('button[aria-pressed]');
    openRows.forEach((r) => expect(r.getAttribute("tabindex")).toBe("0"));
  });
});
