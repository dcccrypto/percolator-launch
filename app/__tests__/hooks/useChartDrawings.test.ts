import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChartDrawings } from "@/hooks/useChartDrawings";
import {
  DRAWINGS_STORAGE_VERSION,
  MAX_DRAWINGS_PER_SLAB,
  type Drawing,
} from "@/lib/chart-drawings";

// Real Solana base58 pubkeys (44 chars). Two distinct values so the
// per-slab isolation tests exercise actual key namespacing rather than
// the trivial empty-string path.
const SLAB_A = "So11111111111111111111111111111111111111112";
const SLAB_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STORAGE_KEY_A = `perc:chart:drawings:${SLAB_A}`;
const STORAGE_KEY_B = `perc:chart:drawings:${SLAB_B}`;

function envelope(drawings: Drawing[]): string {
  return JSON.stringify({ version: DRAWINGS_STORAGE_VERSION, drawings });
}

describe("useChartDrawings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns an empty list on first mount with no stored data", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    expect(result.current.drawings).toEqual([]);
  });

  it("hydrates from localStorage on mount when stored data exists", () => {
    const stored: Drawing = {
      id: "h-1",
      kind: "horizontal",
      price: 100,
    };
    window.localStorage.setItem(STORAGE_KEY_A, envelope([stored]));
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    expect(result.current.drawings).toEqual([stored]);
  });

  it("addDrawing appends a new drawing with a generated id and persists", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    expect(result.current.drawings).toHaveLength(1);
    expect(result.current.drawings[0].kind).toBe("horizontal");
    expect(result.current.drawings[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    // Persisted under the slab key.
    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_A) ?? "{}",
    );
    expect(persisted.version).toBe(DRAWINGS_STORAGE_VERSION);
    expect(persisted.drawings).toHaveLength(1);
  });

  it("addDrawing accepts each drawing kind with the correct shape", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({
        kind: "trend",
        p1: { time: 1_700_000_000_000, price: 100 },
        p2: { time: 1_700_000_060_000, price: 110 },
      });
      result.current.addDrawing({ kind: "horizontal", price: 105 });
      result.current.addDrawing({
        kind: "rectangle",
        p1: { time: 1_700_000_000_000, price: 90 },
        p2: { time: 1_700_000_120_000, price: 120 },
      });
    });
    expect(result.current.drawings.map((d) => d.kind)).toEqual([
      "trend",
      "horizontal",
      "rectangle",
    ]);
  });

  it("deleteDrawing removes by id and persists", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
      result.current.addDrawing({ kind: "horizontal", price: 200 });
    });
    const targetId = result.current.drawings[0].id;
    act(() => {
      result.current.deleteDrawing(targetId);
    });
    expect(result.current.drawings).toHaveLength(1);
    expect(result.current.drawings[0].id).not.toBe(targetId);
    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_A) ?? "{}",
    );
    expect(persisted.drawings).toHaveLength(1);
  });

  it("clearAll empties the list and persists empty", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
      result.current.addDrawing({ kind: "horizontal", price: 200 });
    });
    act(() => {
      result.current.clearAll();
    });
    expect(result.current.drawings).toEqual([]);
    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_A) ?? "{}",
    );
    expect(persisted.drawings).toEqual([]);
  });

  it("addDrawing past the cap drops the OLDEST entry (FIFO)", () => {
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      for (let i = 0; i < MAX_DRAWINGS_PER_SLAB; i++) {
        result.current.addDrawing({ kind: "horizontal", price: i });
      }
    });
    const firstId = result.current.drawings[0].id;
    expect(result.current.drawings).toHaveLength(MAX_DRAWINGS_PER_SLAB);

    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 9999 });
    });
    expect(result.current.drawings).toHaveLength(MAX_DRAWINGS_PER_SLAB);
    expect(result.current.drawings[0].id).not.toBe(firstId); // oldest dropped
    expect(
      result.current.drawings[MAX_DRAWINGS_PER_SLAB - 1],
    ).toMatchObject({ kind: "horizontal", price: 9999 });
  });

  it("re-hydrates with the new slab's data when slabAddress changes", () => {
    const drawingA: Drawing = { id: "a", kind: "horizontal", price: 100 };
    const drawingB: Drawing = { id: "b", kind: "horizontal", price: 200 };
    window.localStorage.setItem(STORAGE_KEY_A, envelope([drawingA]));
    window.localStorage.setItem(STORAGE_KEY_B, envelope([drawingB]));

    const { result, rerender } = renderHook(
      ({ slab }: { slab: string }) => useChartDrawings(slab),
      { initialProps: { slab: SLAB_A } },
    );
    expect(result.current.drawings).toEqual([drawingA]);

    rerender({ slab: SLAB_B });
    expect(result.current.drawings).toEqual([drawingB]);
  });

  it("isolates writes per slab (slab A's writes don't leak into slab B)", () => {
    const { result, rerender } = renderHook(
      ({ slab }: { slab: string }) => useChartDrawings(slab),
      { initialProps: { slab: SLAB_A } },
    );
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    rerender({ slab: SLAB_B });
    expect(result.current.drawings).toEqual([]);
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 200 });
    });
    expect(result.current.drawings).toHaveLength(1);

    rerender({ slab: SLAB_A });
    expect(result.current.drawings).toHaveLength(1);
    expect(result.current.drawings[0]).toMatchObject({ price: 100 });
  });

  it("returns an empty list and skips storage for an invalid slab address", () => {
    const writeSpy = vi.spyOn(window.localStorage.__proto__, "setItem");
    const readSpy = vi.spyOn(window.localStorage.__proto__, "getItem");

    const { result } = renderHook(() => useChartDrawings(""));
    expect(result.current.drawings).toEqual([]);
    // Read was not attempted for the invalid slab.
    expect(
      readSpy.mock.calls.some((call) =>
        String(call[0]).startsWith("perc:chart:drawings:"),
      ),
    ).toBe(false);

    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    // Write was not attempted for the invalid slab — bucket can't be poisoned.
    expect(
      writeSpy.mock.calls.some((call) =>
        String(call[0]).startsWith("perc:chart:drawings:"),
      ),
    ).toBe(false);
  });

  it("rejects a slab address that doesn't match the base58 pubkey shape", () => {
    const writeSpy = vi.spyOn(window.localStorage.__proto__, "setItem");
    const { result } = renderHook(() =>
      useChartDrawings("not-a-valid-pubkey"),
    );
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    expect(result.current.drawings).toHaveLength(1); // in-memory still works
    expect(
      writeSpy.mock.calls.some((call) =>
        String(call[0]).startsWith("perc:chart:drawings:"),
      ),
    ).toBe(false);
  });

  it("swallows quota errors on write without rolling back in-memory state", () => {
    const setItemSpy = vi
      .spyOn(window.localStorage.__proto__, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    expect(result.current.drawings).toHaveLength(1);
    expect(setItemSpy).toHaveBeenCalled();
  });

  it("treats a localStorage value with the wrong version as empty", () => {
    window.localStorage.setItem(
      STORAGE_KEY_A,
      JSON.stringify({
        version: DRAWINGS_STORAGE_VERSION + 1,
        drawings: [{ id: "future", kind: "horizontal", price: 100 }],
      }),
    );
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    expect(result.current.drawings).toEqual([]);
  });

  it("treats a non-JSON localStorage value as empty (does not crash)", () => {
    window.localStorage.setItem(STORAGE_KEY_A, "{not valid json");
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    expect(result.current.drawings).toEqual([]);
  });
});
