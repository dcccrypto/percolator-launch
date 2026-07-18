/**
 * GH#2416 — unbounded oracle publisher cache allowed a memory-exhaustion DoS.
 *
 * `GET /api/oracle/publishers` built its cache key from request-controlled
 * query params (`mode`, `feedId`, `authority`) and stored every result in a
 * module-level `Map` with no cap, no eviction, and no deletion of stale
 * entries. `mode=admin&authority=<anything>` is unauthenticated and accepted
 * arbitrary strings, so a caller could mint unlimited unique keys.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/oracle/publishers/route";

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/oracle/publishers?${query}`);
}

/** A syntactically valid base58 Solana pubkey. */
const VALID_AUTHORITY = "BXzwCWKsMpAW2MxWTWPaJu4fByYWkBFGBmLz4QxGUkwi";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("GH#2416 oracle/publishers cache DoS", () => {
  it("rejects a non-base58 authority instead of caching it", async () => {
    const res = await GET(req(`mode=admin&authority=${"A".repeat(5000)}`));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toMatch(/authority/i);
  });

  it.each([
    ["too short", "abc"],
    ["non-base58 chars (0OIl)", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"],
    ["oversized", "1".repeat(200)],
    ["path traversal", "../../etc/passwd"],
    ["empty-ish whitespace", "   "],
  ])("rejects malformed authority: %s", async (_label, authority) => {
    const res = await GET(req(`mode=admin&authority=${encodeURIComponent(authority)}`));
    expect(res.status).toBe(400);
  });

  it("still serves a valid admin authority", async () => {
    const res = await GET(req(`mode=admin&authority=${VALID_AUTHORITY}`));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.mode).toBe("admin");
    expect(body.publisherCount).toBe(1);
    expect(body.publishers[0].key).toBe(VALID_AUTHORITY);
  });

  it("does not grow unboundedly across many unique valid authorities", async () => {
    // The DoS shape, using only authorities that now pass validation. Admin
    // mode is served uncached, so none of these are retained at all.
    const before = process.memoryUsage().heapUsed;

    for (let i = 0; i < 300; i++) {
      // Vary within the base58 alphabet to produce distinct valid-looking keys.
      const authority = VALID_AUTHORITY.slice(0, -2) + ["ab", "cd", "ef", "gh"][i % 4] ;
      const res = await GET(req(`mode=admin&authority=${authority}`));
      expect(res.status).toBe(200);
    }

    // Not asserting an exact number — just that 300 unique unauthenticated
    // requests do not retain a proportional amount of heap.
    const grewMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(grewMb).toBeLessThan(50);
  });

  it("requires a mode and rejects unknown modes", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("mode=not-a-real-mode"))).status).toBe(400);
  });

  it("still validates feedId for pyth-pinned mode", async () => {
    expect((await GET(req("mode=pyth-pinned"))).status).toBe(400);
    expect((await GET(req("mode=pyth-pinned&feedId=nothex"))).status).toBe(400);
    expect((await GET(req(`mode=pyth-pinned&feedId=${"a".repeat(200)}`))).status).toBe(400);
  });
});
