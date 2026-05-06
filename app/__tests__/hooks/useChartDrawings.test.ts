import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

/** Persistence is debounced by 250 ms. Most tests assert localStorage
 *  state right after a mutation, so the trailing timer needs to fire
 *  inline. Wrap in act() so any synchronous React-state side effects
 *  from the timer's callback flush within React's batch. */
function flushPersist(): void {
  act(() => {
    vi.runAllTimers();
  });
}

describe("useChartDrawings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    // Fake only timer-related globals; leave Date / performance.now
    // alone so other code that timestamps doesn't get warped.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    // Flush the 250 ms persist debounce before reading localStorage.
    flushPersist();
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
    flushPersist();
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
    flushPersist();
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
    // Flush in case any timer is pending (it shouldn't be; the
    // invalid-slab guard rejects the schedule entirely, but assert
    // post-flush so the test fails closed if that guard ever moves).
    flushPersist();
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
    flushPersist();
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
    flushPersist();
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

  it("does not crash when localStorage.getItem throws (Safari Private Mode)", () => {
    // Safari throws on getItem in some private-mode configurations.
    // The effect's try/catch must cover the read path AND the parse
    // path — narrowing it to JSON.parse only would crash render here.
    vi.spyOn(window.localStorage.__proto__, "getItem").mockImplementation(
      () => {
        throw new Error("QuotaExceededError");
      },
    );
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    expect(result.current.drawings).toEqual([]);
  });

  it("addDrawing writes to the NEW slab when called immediately after a slab change", () => {
    // Race: slabAddress prop changes from A to B. The hydration effect
    // for B will fire after commit, but a setter fired between the
    // commit and that effect must persist to the NEW slab. The fix is
    // to assign slabRef.current synchronously during render — this
    // test pins that contract.
    window.localStorage.setItem(STORAGE_KEY_A, envelope([]));
    const { result, rerender } = renderHook(
      ({ slab }: { slab: string }) => useChartDrawings(slab),
      { initialProps: { slab: SLAB_A } },
    );
    rerender({ slab: SLAB_B });
    // Capture addDrawing AFTER the rerender (post-render-time ref
    // assignment) and call it immediately.
    const add = result.current.addDrawing;
    act(() => {
      add({ kind: "horizontal", price: 100 });
    });
    flushPersist();
    // Write must land under SLAB_B's key.
    const persistedB = window.localStorage.getItem(STORAGE_KEY_B);
    expect(persistedB).toBeTruthy();
    const parsedB = JSON.parse(persistedB ?? "{}");
    expect(parsedB.drawings).toHaveLength(1);
    // SLAB_A's key must NOT have received the new drawing.
    const persistedA = window.localStorage.getItem(STORAGE_KEY_A);
    const parsedA = JSON.parse(persistedA ?? "{}");
    expect(parsedA.drawings ?? []).toEqual([]);
  });

  it("coalesces a burst of mutations within the debounce window into one setItem", () => {
    // The audit's perf concern: 30 mutations in 30 seconds = 30
    // blocking setItem calls without debouncing. With a 250 ms
    // trailing window, a tight burst should flush exactly once.
    const setItemSpy = vi.spyOn(window.localStorage.__proto__, "setItem");
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
      result.current.addDrawing({ kind: "horizontal", price: 200 });
      result.current.addDrawing({ kind: "horizontal", price: 300 });
    });
    // Mid-burst (timer still pending): no write has landed yet.
    const drawingsKeyWritesMidBurst = setItemSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("perc:chart:drawings:"),
    );
    expect(drawingsKeyWritesMidBurst).toHaveLength(0);
    // Trailing fire flushes once with the final state.
    flushPersist();
    const drawingsKeyWritesAfter = setItemSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("perc:chart:drawings:"),
    );
    expect(drawingsKeyWritesAfter).toHaveLength(1);
    const finalEnvelope = JSON.parse(drawingsKeyWritesAfter[0][1] as string);
    expect(finalEnvelope.drawings).toHaveLength(3);
  });

  it("pagehide flushes a pending write immediately", () => {
    // Mobile users closing the tab inside the 250 ms window would
    // otherwise lose the last drawing. The pagehide handler flushes
    // the pending write before the tab dies. Note: beforeunload is
    // unreliable on iOS Safari for mobile tabs; pagehide is the
    // documented choice.
    const setItemSpy = vi.spyOn(window.localStorage.__proto__, "setItem");
    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    // Fire pagehide before the trailing timer would have expired.
    window.dispatchEvent(new Event("pagehide"));
    const drawingsKeyWrites = setItemSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("perc:chart:drawings:"),
    );
    expect(drawingsKeyWrites).toHaveLength(1);
  });

  it("generateId runs outside the state updater (single uuid per logical add)", () => {
    // React 18 may invoke state updater functions twice (Strict Mode in
    // dev, discarded renders in concurrent mode). generateId must run
    // OUTSIDE the updater so a single addDrawing call produces exactly
    // one uuid. If it were inside, double-invocation would produce two
    // different uuids and the disk persisted under each, leaving a
    // brief window where in-memory state and disk disagree.
    let uuidCallCount = 0;
    const realRandomUUID = crypto.randomUUID.bind(crypto);
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      uuidCallCount++;
      return realRandomUUID();
    });

    const { result } = renderHook(() => useChartDrawings(SLAB_A));
    act(() => {
      result.current.addDrawing({ kind: "horizontal", price: 100 });
    });
    expect(uuidCallCount).toBe(1);
    expect(result.current.drawings).toHaveLength(1);
  });
});
