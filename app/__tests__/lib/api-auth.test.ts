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

  describe("dev mode (no INDEXER_API_KEY set)", () => {
    it("allows all requests in non-production", () => {
      delete process.env.INDEXER_API_KEY;
      process.env.NODE_ENV = "development";
      expect(requireAuth(mockRequest())).toBe(true);
    });

    it("allows requests with any header in dev", () => {
      delete process.env.INDEXER_API_KEY;
      process.env.NODE_ENV = "development";
      expect(requireAuth(mockRequest({ "x-api-key": "anything" }))).toBe(true);
    });
  });

  describe("production without key configured (R2-S9)", () => {
    it("rejects all requests when INDEXER_API_KEY is not set", () => {
      delete process.env.INDEXER_API_KEY;
      process.env.NODE_ENV = "production";
      expect(requireAuth(mockRequest())).toBe(false);
    });

    it("rejects even requests with an x-api-key header", () => {
      delete process.env.INDEXER_API_KEY;
      process.env.NODE_ENV = "production";
      expect(requireAuth(mockRequest({ "x-api-key": "some-key" }))).toBe(false);
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
  });
});
