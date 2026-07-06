import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireAuth } from "@/lib/api-auth";

const originalEnv = { ...process.env };

/** Minimal NextRequest mock with headers */
function mockRequest(headers: Record<string, string> = {}) {
  return {
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as import("next/server").NextRequest;
}

describe("requireAuth", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Differential (anti-hollow): confirm the exact FAIL direction, then the PASS direction.
  // Without INDEXER_API_KEY, every call must be rejected regardless of NODE_ENV — staging
  // and preview deployments run as NODE_ENV=development but serve real data.
  describe("fail-closed when INDEXER_API_KEY is not configured", () => {
    for (const env of ["production", "development", "test", undefined] as const) {
      const label = env ?? "(unset)";
      it(`rejects all requests in NODE_ENV=${label} — wrong path`, () => {
        delete process.env.INDEXER_API_KEY;
        if (env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = env;
        expect(requireAuth(mockRequest())).toBe(false);
        expect(requireAuth(mockRequest({ "x-api-key": "anything" }))).toBe(false);
      });
    }

    it("passes once INDEXER_API_KEY is set — right path", () => {
      delete process.env.NODE_ENV; // not production
      process.env.INDEXER_API_KEY = "dev-local-key";
      expect(requireAuth(mockRequest({ "x-api-key": "dev-local-key" }))).toBe(true);
    });
  });

  describe("with INDEXER_API_KEY configured", () => {
    it("allows matching key", () => {
      process.env.INDEXER_API_KEY = "secret-123";
      expect(requireAuth(mockRequest({ "x-api-key": "secret-123" }))).toBe(true);
    });

    it("rejects wrong key", () => {
      process.env.INDEXER_API_KEY = "secret-123";
      expect(requireAuth(mockRequest({ "x-api-key": "wrong" }))).toBe(false);
    });

    it("rejects missing header", () => {
      process.env.INDEXER_API_KEY = "secret-123";
      expect(requireAuth(mockRequest())).toBe(false);
    });

    it("rejects empty header", () => {
      process.env.INDEXER_API_KEY = "secret-123";
      expect(requireAuth(mockRequest({ "x-api-key": "" }))).toBe(false);
    });

    it("is case-sensitive", () => {
      process.env.INDEXER_API_KEY = "Secret-123";
      expect(requireAuth(mockRequest({ "x-api-key": "secret-123" }))).toBe(false);
    });

    it("uses timing-safe comparison (PERC-597): does not throw on long vs short keys", () => {
      // timingSafeEqual throws when buffers differ in length if called directly on raw strings;
      // our hash-based wrapper must handle this without error.
      process.env.INDEXER_API_KEY = "a";
      expect(requireAuth(mockRequest({ "x-api-key": "a-very-long-key-value-that-differs-in-length" }))).toBe(false);
    });

    it("uses timing-safe comparison (PERC-597): correct long key accepted", () => {
      const longKey = "a-very-long-api-key-value-1234567890abcdef";
      process.env.INDEXER_API_KEY = longKey;
      expect(requireAuth(mockRequest({ "x-api-key": longKey }))).toBe(true);
    });
  });
});
