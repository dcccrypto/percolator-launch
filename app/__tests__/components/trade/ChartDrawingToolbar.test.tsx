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

  it.each(["trend", "horizontal", "rectangle"] as const)(
    "Escape returns to pointer from %s",
    (active) => {
      const setTool = vi.fn();
      render(<ChartDrawingToolbar tool={active} setTool={setTool} />);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(setTool).toHaveBeenCalledWith("pointer");
    },
  );

  it("Escape is a no-op when the tool is already pointer", () => {
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="pointer" setTool={setTool} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("Escape with focus inside an INPUT is suppressed (input-focus guard)", () => {
    const setTool = vi.fn();
    render(
      <>
        <input data-testid="form-input" />
        <ChartDrawingToolbar tool="trend" setTool={setTool} />
      </>,
    );
    const input = screen.getByTestId("form-input") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("Escape with focus inside a TEXTAREA is suppressed", () => {
    const setTool = vi.fn();
    render(
      <>
        <textarea data-testid="form-textarea" />
        <ChartDrawingToolbar tool="trend" setTool={setTool} />
      </>,
    );
    const ta = screen.getByTestId("form-textarea") as HTMLTextAreaElement;
    ta.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("Escape with focus inside a contenteditable is suppressed", () => {
    const setTool = vi.fn();
    render(
      <>
        {/* tabIndex=0 makes the contenteditable focusable in jsdom.
            jsdom doesn't compute isContentEditable from the
            attribute, so we patch the property on the element after
            it mounts so the input-focus guard's runtime check runs
            against a representative DOM shape. */}
        <div
          data-testid="ce"
          contentEditable
          tabIndex={0}
          suppressContentEditableWarning
        />
        <ChartDrawingToolbar tool="trend" setTool={setTool} />
      </>,
    );
    const ce = screen.getByTestId("ce") as HTMLDivElement;
    Object.defineProperty(ce, "isContentEditable", {
      value: true,
      configurable: true,
    });
    ce.focus();
    expect(document.activeElement).toBe(ce);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("non-Escape keys do not call setTool", () => {
    const setTool = vi.fn();
    render(<ChartDrawingToolbar tool="trend" setTool={setTool} />);
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: " " });
    fireEvent.keyDown(document, { key: "p" });
    expect(setTool).not.toHaveBeenCalled();
  });

  it("removes the keydown listener on unmount", () => {
    const setTool = vi.fn();
    const { unmount } = render(
      <ChartDrawingToolbar tool="trend" setTool={setTool} />,
    );
    unmount();
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
