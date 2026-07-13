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

// Cleanup after each test
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
