import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChartDrawingTool } from "@/hooks/useChartDrawingTool";

const STORAGE_KEY = "perc:chart:drawing-tool";

describe("useChartDrawingTool", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults to pointer when nothing is stored", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("pointer");
  });

  it("hydrates from localStorage when a valid value is stored", () => {
    window.localStorage.setItem(STORAGE_KEY, "trend");
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("trend");
  });

  it.each(["pointer", "trend", "horizontal", "rectangle"] as const)(
    "accepts each valid tool kind on hydrate (%s)",
    (kind) => {
      window.localStorage.setItem(STORAGE_KEY, kind);
      const { result } = renderHook(() => useChartDrawingTool());
      expect(result.current.tool).toBe(kind);
    },
  );

  it.each([
    "ellipse",
    "vertical",
    "",
    "POINTER",
    "{}",
    "null",
  ])(
    "ignores invalid stored value (%s) and stays on pointer default",
    (stored) => {
      window.localStorage.setItem(STORAGE_KEY, stored);
      const { result } = renderHook(() => useChartDrawingTool());
      expect(result.current.tool).toBe("pointer");
    },
  );

  it("setTool updates state and persists to localStorage", () => {
    const { result } = renderHook(() => useChartDrawingTool());
    act(() => {
      result.current.setTool("rectangle");
    });
    expect(result.current.tool).toBe("rectangle");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("rectangle");
  });

  it("setTool can return to pointer (deselect via toolbar click)", () => {
    window.localStorage.setItem(STORAGE_KEY, "trend");
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("trend");
    act(() => {
      result.current.setTool("pointer");
    });
    expect(result.current.tool).toBe("pointer");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("pointer");
  });

  it("swallows quota errors on write without rolling back state", () => {
    const setItemSpy = vi
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const { result } = renderHook(() => useChartDrawingTool());
    act(() => {
      result.current.setTool("trend");
    });
    expect(result.current.tool).toBe("trend"); // in-memory state still updates
    expect(setItemSpy).toHaveBeenCalled();
  });

  it("does not crash when localStorage.getItem throws (Safari Private Mode)", () => {
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(
      () => {
        throw new Error("QuotaExceededError");
      },
    );
    const { result } = renderHook(() => useChartDrawingTool());
    expect(result.current.tool).toBe("pointer");
  });

  it("setTool reference is stable across re-renders", () => {
    const { result, rerender } = renderHook(() => useChartDrawingTool());
    const firstRef = result.current.setTool;
    rerender();
    expect(result.current.setTool).toBe(firstRef);
  });
});
