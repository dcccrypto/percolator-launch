import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChartDrawingToolbar } from "@/components/trade/ChartDrawingToolbar";
import type { DrawingTool } from "@/lib/chart-drawings";

const noopProps = {
  tool: "pointer" as DrawingTool,
  setTool: () => {},
  drawingCount: 0,
  clearAll: () => {},
};

describe("ChartDrawingToolbar", () => {
  it("renders a labelled container without overstating ARIA contract", () => {
    // Deliberately not role="toolbar" — the APG toolbar pattern
    // requires roving tabindex + arrow-key focus management which we
    // don't implement. A plain labelled div is honest semantics.
    render(<ChartDrawingToolbar {...noopProps} />);
    const tb = screen.getByLabelText(/Drawing tools/i);
    expect(tb).toBeInTheDocument();
    expect(tb).not.toHaveAttribute("role", "toolbar");
    expect(tb).not.toHaveAttribute("aria-orientation");
  });

  it("renders one button per drawing tool (pointer + 3 creation tools)", () => {
    render(<ChartDrawingToolbar {...noopProps} />);
    expect(screen.getByRole("button", { name: /Pointer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Trend line/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Horizontal line/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rectangle/i })).toBeInTheDocument();
  });

  it("marks the active tool with aria-pressed=true and others false", () => {
    render(<ChartDrawingToolbar {...noopProps} tool="trend" />);
    expect(
      screen.getByRole("button", { name: /Trend line/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /Pointer/i }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: /Horizontal line/i }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: /Rectangle/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking an inactive tool calls setTool with that kind", () => {
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="pointer" setTool={setTool} />);
    fireEvent.click(screen.getByRole("button", { name: /Trend line/i }));
    expect(setTool).toHaveBeenCalledWith("trend");
  });

  it("clicking the active non-pointer tool returns to pointer", () => {
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="rectangle" setTool={setTool} />);
    fireEvent.click(screen.getByRole("button", { name: /Rectangle/i }));
    expect(setTool).toHaveBeenCalledWith("pointer");
  });

  it("clicking the active pointer tool sets pointer (no-op equivalent)", () => {
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="pointer" setTool={setTool} />);
    fireEvent.click(screen.getByRole("button", { name: /Pointer/i }));
    expect(setTool).toHaveBeenCalledWith("pointer");
  });

  it("does NOT register a keydown listener (Escape is owned by the overlay)", () => {
    // The Escape priority chain (cancel-pending → deselect → reset-tool)
    // lives in ChartDrawingOverlay so a single handler can sequence
    // those states. The toolbar must not race a second handler for
    // the same key.
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="trend" setTool={setTool} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("hides the toolbar below the md breakpoint via responsive classes", () => {
    // Visual gate: the toolbar uses Tailwind's `hidden md:flex` so it
    // only appears on tablets+. Pinned via class assertion since
    // jsdom doesn't run media queries.
    render(<ChartDrawingToolbar {...noopProps} />);
    const tb = screen.getByLabelText(/Drawing tools/i);
    expect(tb.className).toContain("hidden");
    expect(tb.className).toContain("md:flex");
  });

  it("each tool button exposes a hover-tooltip via title attribute", () => {
    // title gives sighted mouse users the tool name on hover
    // (icons alone are abstract). Pinned so a refactor that drops
    // title doesn't silently break discoverability — aria-pressed +
    // aria-label tests would still pass.
    render(<ChartDrawingToolbar {...noopProps} />);
    expect(
      screen.getByRole("button", { name: /Pointer/i }),
    ).toHaveAttribute("title", "Pointer (select)");
    expect(
      screen.getByRole("button", { name: /Trend line/i }),
    ).toHaveAttribute("title", "Trend line");
    expect(
      screen.getByRole("button", { name: /Horizontal line/i }),
    ).toHaveAttribute("title", "Horizontal line");
    expect(
      screen.getByRole("button", { name: /Rectangle/i }),
    ).toHaveAttribute("title", "Rectangle");
  });

  it("active tool carries the accent-tint background class (visual feedback)", () => {
    // aria-pressed alone doesn't render a visible difference. Pin the
    // accent-tint background class so a refactor that drops the
    // active branch of the className ternary still fails a test.
    render(<ChartDrawingToolbar {...noopProps} tool="trend" />);
    const trend = screen.getByRole("button", { name: /Trend line/i });
    expect(trend.className).toContain("bg-[var(--accent)]/10");
    expect(trend.className).toContain("text-[var(--accent)]");
    // And the inactive button does NOT carry the active classes.
    const pointer = screen.getByRole("button", { name: /Pointer/i });
    expect(pointer.className).not.toContain("bg-[var(--accent)]/10");
  });

  describe("clear-all button", () => {
    it("renders below a separator", () => {
      render(<ChartDrawingToolbar {...noopProps} drawingCount={3} />);
      expect(
        screen.getByRole("separator", { hidden: true }) ??
          screen.getByRole("separator"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Clear all drawings/i }),
      ).toBeInTheDocument();
    });

    it("is disabled when drawingCount is 0", () => {
      render(<ChartDrawingToolbar {...noopProps} drawingCount={0} />);
      const btn = screen.getByRole("button", { name: /Clear all drawings/i });
      expect(btn).toBeDisabled();
    });

    it("is enabled when drawingCount > 0", () => {
      render(<ChartDrawingToolbar {...noopProps} drawingCount={1} />);
      const btn = screen.getByRole("button", { name: /Clear all drawings/i });
      expect(btn).toBeEnabled();
    });

    it("does NOT prompt when count is 0 (defensive: button is disabled but clicks routed via onClick still no-op)", () => {
      const confirmSpy = vi.spyOn(window, "confirm");
      const clearAll = vi.fn();
      const setTool = vi.fn();
      render(
        <ChartDrawingToolbar
          {...noopProps}
          drawingCount={0}
          clearAll={clearAll}
          setTool={setTool}
        />,
      );
      const btn = screen.getByRole("button", { name: /Clear all drawings/i });
      // Browser blocks click on disabled, but force a click via fireEvent
      // to verify the JS-side guard (some test harnesses bypass disabled).
      fireEvent.click(btn);
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(clearAll).not.toHaveBeenCalled();
      expect(setTool).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("prompts via window.confirm with the drawing count when clicked", () => {
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(true);
      const clearAll = vi.fn();
      render(
        <ChartDrawingToolbar
          {...noopProps}
          drawingCount={5}
          clearAll={clearAll}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Clear all drawings/i }),
      );
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      const message = confirmSpy.mock.calls[0][0] as string;
      expect(message).toContain("5");
      expect(message).toContain("drawings");
      expect(clearAll).toHaveBeenCalledTimes(1);
      confirmSpy.mockRestore();
    });

    it("uses singular wording when drawingCount === 1", () => {
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(true);
      render(
        <ChartDrawingToolbar
          {...noopProps}
          drawingCount={1}
          clearAll={() => {}}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Clear all drawings/i }),
      );
      const message = confirmSpy.mock.calls[0][0] as string;
      expect(message).toContain("1 drawing");
      expect(message).not.toContain("drawings");
      confirmSpy.mockRestore();
    });

    it("does NOT call clearAll when the user cancels the prompt", () => {
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(false);
      const clearAll = vi.fn();
      const setTool = vi.fn();
      render(
        <ChartDrawingToolbar
          {...noopProps}
          drawingCount={3}
          clearAll={clearAll}
          setTool={setTool}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Clear all drawings/i }),
      );
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(clearAll).not.toHaveBeenCalled();
      expect(setTool).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("resets the active tool to pointer after a confirmed clear", () => {
      const confirmSpy = vi
        .spyOn(window, "confirm")
        .mockReturnValue(true);
      const clearAll = vi.fn();
      const setTool = vi.fn();
      render(
        <ChartDrawingToolbar
          {...noopProps}
          tool="trend"
          drawingCount={3}
          clearAll={clearAll}
          setTool={setTool}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Clear all drawings/i }),
      );
      expect(clearAll).toHaveBeenCalledTimes(1);
      expect(setTool).toHaveBeenCalledWith("pointer");
      confirmSpy.mockRestore();
    });
  });
});
