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

// `window.localStorage` in this environment is a bare object with NO Storage
// methods on it at all — `getItem`, `setItem`, `clear` and friends are all
// `undefined` (verified: no constructor, prototype is Object.prototype). Any
// test touching persistence therefore either throws
// ("localStorage.clear is not a function") or, worse, silently exercises
// nothing. Only 3 of ~259 test files worked around it with their own
// `vi.stubGlobal` mock; everything else ran against a dead Storage.
//
// Install a real in-memory Storage so persistence behaviour is actually
// exercised. Guarded on `getItem` being missing, so if the environment ever
// gains a working implementation this defers to it rather than shadowing it.
// Per-file `vi.stubGlobal('localStorage', ...)` still overrides this.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.has(String(key)) ? this.store.get(String(key))! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.store.delete(String(key));
  }

  clear(): void {
    this.store.clear();
  }

  [name: string]: any;
}

if (typeof window !== 'undefined') {
  for (const kind of ['localStorage', 'sessionStorage'] as const) {
    const existing = (window as any)[kind];
    if (!existing || typeof existing.getItem !== 'function') {
      Object.defineProperty(window, kind, {
        configurable: true,
        writable: true,
        value: new MemoryStorage(),
      });
    }
  }
}

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Storage is module-level state that outlives a test; leaving entries behind
  // lets one test's persisted keys silently satisfy the next one's assertions.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.clear?.();
      window.sessionStorage?.clear?.();
    } catch {
      // A test may have stubbed Storage with a partial mock — never fail teardown.
    }
  }
});
