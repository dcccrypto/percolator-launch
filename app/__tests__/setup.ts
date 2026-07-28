import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import '@testing-library/jest-dom';

// jsdom doesn't implement window.matchMedia — mock it so hooks like
// usePrefersReducedMotion don't throw during component tests.
//
// Guarded by `typeof window !== 'undefined'`: this setup file runs for EVERY
// test file regardless of that file's own `@vitest-environment` docblock
// (setupFiles is a global config, not per-environment). A handful of
// server-route tests (e.g. __tests__/api/market-logo-ownership-auth.test.ts)
// opt into `@vitest-environment node` — real Next.js API routes only ever
// run in Node, and jsdom's realm-separated `TextEncoder`/`Uint8Array` makes
// tweetnacl's `instanceof Uint8Array` check spuriously fail there (a
// test-environment artifact, not a product bug) — so `window` doesn't exist
// for them.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ── Web Storage polyfill ──────────────────────────────────────────────────────
//
// Under this jsdom setup `window.localStorage` is a PLAIN EMPTY OBJECT — no
// getItem, no setItem, no clear (verified: its prototype is Object.prototype).
// So every test touching storage died on the first call, which is why the whole
// useChartDrawings / useChartDrawingTool suites failed as a block (29 tests)
// with `window.localStorage.clear is not a function`. That is one missing
// global, not 29 broken behaviours.
//
// Methods are defined as OWN, writable, configurable properties so tests can
// still `vi.spyOn(window.localStorage, "setItem")` — several deliberately do,
// to simulate a quota error or Safari Private Mode throwing on read.
// Methods live on a shared PROTOTYPE, not on the instance, because the suites
// spy via `vi.spyOn(window.localStorage.__proto__, "setItem")` — which is also
// how real jsdom behaves (every Storage shares Storage.prototype). Putting them
// on the instance makes the prototype empty and spyOn throws
// "The property setItem is not defined on the object".
const storageBacking = new WeakMap<object, Map<string, string>>();

class MemoryStorage {
  constructor() {
    storageBacking.set(this, new Map());
  }
  private get map(): Map<string, string> {
    let m = storageBacking.get(this);
    if (!m) { m = new Map(); storageBacking.set(this, m); }
    return m;
  }
  getItem(key: string): string | null {
    const v = this.map.get(String(key));
    return v === undefined ? null : v;
  }
  setItem(key: string, value: string): void {
    this.map.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.map.delete(String(key));
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

function createStorage(): Storage {
  return new MemoryStorage() as unknown as Storage;
}

// Guarded: some suites opt into `@vitest-environment node`, where `window` does
// not exist. Touching it unconditionally here throws ReferenceError during
// setup and fails those files before their first test runs.
const hasWindow = typeof window !== "undefined";
for (const name of ["localStorage", "sessionStorage"] as const) {
  const impl = createStorage();
  if (hasWindow) {
    Object.defineProperty(window, name, { value: impl, writable: true, configurable: true });
  }
  // jsdom's window is not always the same object the module under test closes
  // over, so mirror onto globalThis too (and in node this is the only target).
  Object.defineProperty(globalThis, name, { value: impl, writable: true, configurable: true });
}

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
