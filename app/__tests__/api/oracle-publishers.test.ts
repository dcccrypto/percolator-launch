// @vitest-environment node
/**
 * Oracle Publishers API Route Tests
 * Tests: ORACLE-007, ORACLE-008, ORACLE-009
 *
 * ORACLE-007: pyth-pinned mode is gone (NO PYTH) — 400, no network call
 * ORACLE-008: Returns publisher data for admin mode
 * ORACLE-009: Handles missing/invalid parameters gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch for oracle bridge calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import the route handler after mocking fetch
import { GET } from "@/app/api/oracle/publishers/route";
import { NextRequest } from "next/server";

function makeRequest(params: Record<string, string>): NextRequest {
  const url = new URL("http://localhost:3000/api/oracle/publishers");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

describe("GET /api/oracle/publishers", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ORACLE-009: returns 400 if mode is missing", async () => {
    const resp = await GET(makeRequest({}));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Missing mode");
  });

  it("ORACLE-009: returns 400 for unknown mode", async () => {
    const resp = await GET(makeRequest({ mode: "unknown" }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Unknown mode");
  });

  it("ORACLE-007: pyth-pinned is not a mode any more — 400, and no upstream call", async () => {
    for (const params of [
      { mode: "pyth-pinned" },
      { mode: "pyth-pinned", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
    ]) {
      const resp = await GET(makeRequest(params));
      expect(resp.status).toBe(400);
      const body = await resp.json();
      expect(body.error).toContain("Unknown mode");
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ORACLE-008: returns single publisher for admin mode with authority", async () => {
    const authority = "7uWa9q1vKqNKbhj4WSvMWdRLCqjJaFWjk6Jk1H9d6Cde";
    const resp = await GET(makeRequest({ mode: "admin", authority }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mode).toBe("admin");
    expect(body.publisherCount).toBe(1);
    expect(body.publisherTotal).toBe(1);
    expect(body.publishers).toHaveLength(1);
    expect(body.publishers[0].key).toBe(authority);
    expect(body.publishers[0].status).toBe("active");
  });

  it("ORACLE-008: returns empty for admin mode with zero authority", async () => {
    const resp = await GET(
      makeRequest({ mode: "admin", authority: "11111111111111111111111111111111" }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.publisherCount).toBe(0);
    expect(body.publishers).toHaveLength(0);
  });

  it("handles hyperp mode with oracle bridge down gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const resp = await GET(makeRequest({ mode: "hyperp" }));
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.mode).toBe("hyperp");
    // Hyperp fallback returns null (not 0) so UI suppresses "0 publishers" text
    expect(body.publisherCount).toBeNull();
  });

  it("hyperp lists the oracle bridge's DEX sources", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ markets: [{ address: "PoolAddr1", symbol: "SOL/USDC" }] }),
    });
    const resp = await GET(makeRequest({ mode: "hyperp" }));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toMatchObject({
      mode: "hyperp",
      publisherCount: 1,
      publishers: [{ key: "PoolAddr1", name: "SOL/USDC", status: "active" }],
    });
    for (const call of mockFetch.mock.calls) expect(String(call[0])).not.toMatch(/pyth/i);
  });
});
