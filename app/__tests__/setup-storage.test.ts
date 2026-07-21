/**
 * Guards the Web Storage polyfill installed by __tests__/setup.ts.
 *
 * This environment's `window.localStorage` is a bare object with no Storage
 * methods on it. Without the polyfill, every persistence test fails with
 * "localStorage.clear is not a function" — 29 of them at once, across files
 * that look unrelated to storage — or silently exercises nothing.
 *
 * If this file goes red, fix the polyfill rather than the tests that depend
 * on it.
 */

import { describe, it, expect } from "vitest";

describe("test environment: Web Storage", () => {
  it.each(["localStorage", "sessionStorage"] as const)(
    "%s implements the full Storage API",
    (kind) => {
      const storage = window[kind];
      expect(storage).toBeDefined();
      for (const method of ["getItem", "setItem", "removeItem", "clear", "key"]) {
        expect(typeof (storage as unknown as Record<string, unknown>)[method]).toBe(
          "function",
        );
      }
    },
  );

  it("round-trips values and reports length", () => {
    localStorage.setItem("alpha", "1");
    localStorage.setItem("beta", "2");

    expect(localStorage.getItem("alpha")).toBe("1");
    expect(localStorage.length).toBe(2);
    expect(localStorage.key(0)).toBe("alpha");

    localStorage.removeItem("alpha");
    expect(localStorage.getItem("alpha")).toBeNull();
    expect(localStorage.length).toBe(1);

    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });

  it("coerces non-string keys and values like the real Storage", () => {
    localStorage.setItem(1 as unknown as string, 2 as unknown as string);
    expect(localStorage.getItem("1")).toBe("2");
  });

  it("returns null for a missing key rather than undefined", () => {
    // Callers do `JSON.parse(raw)` guarded on `raw === null`; undefined slips
    // past that guard and throws.
    expect(localStorage.getItem("never-set")).toBeNull();
  });

  it("is cleared between tests", () => {
    // Depends on the preceding tests having written keys — setup.ts's afterEach
    // must have emptied them, or persisted state leaks across the suite.
    expect(localStorage.length).toBe(0);
    localStorage.setItem("leak-check", "x");
  });

  it("did not inherit the previous test's keys", () => {
    expect(localStorage.getItem("leak-check")).toBeNull();
  });
});
