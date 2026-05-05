import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChartDrawingToolbar } from "@/components/trade/ChartDrawingToolbar";
import type { DrawingTool } from "@/lib/chart-drawings";

const noopProps = {
  tool: "pointer" as DrawingTool,
  setTool: () => {},
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
});
