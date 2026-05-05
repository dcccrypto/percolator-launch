import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChartDrawingTool } from "@/hooks/useChartDrawingTool";

const STORAGE_KEY = "perc:chart:drawing-tool";

describe("useChartDrawingTool", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to pointer on every fresh mount", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("pointer");
  });

  it("does NOT hydrate from localStorage — tool selection is session-local", () => {
    // The earlier persisted-tool design trapped returning users: a
    // session left in trend mode silently dropped a trend anchor on
    // the next visit's first click. Tool is intentionally ephemeral
    // now; drawings still persist per-slab, only the tool resets.
    window.localStorage.setItem(STORAGE_KEY, "trend");
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("pointer");
  });

  it("setTool updates in-memory state", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    act(() => {
      result.current.setTool("rectangle");
    });
    expect(result.current.tool).toBe("rectangle");
  });

  it("setTool does NOT write to localStorage", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    act(() => {
      result.current.setTool("trend");
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("setTool can return to pointer (deselect via toolbar click)", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    act(() => {
      result.current.setTool("trend");
    });
    expect(result.current.tool).toBe("trend");
    act(() => {
      result.current.setTool("pointer");
    });
    expect(result.current.tool).toBe("pointer");
  });

  it.each(["pointer", "trend", "horizontal", "rectangle"] as const)(
    "accepts each valid tool kind via setTool (%s)",
    (kind) => {
      const { result } = renderHook(() => useChartDrawingTool());
      act(() => {
        result.current.setTool(kind);
      });
      expect(result.current.tool).toBe(kind);
    },
  );

  it("setTool reference is stable across re-renders", () => {
    const { result, rerender } = renderHook(() => useChartDrawingTool());
    const firstRef = result.current.setTool;
    rerender();
    expect(result.current.setTool).toBe(firstRef);
  });
});
