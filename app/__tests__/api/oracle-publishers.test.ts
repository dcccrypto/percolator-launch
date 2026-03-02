/**
 * Oracle Publishers API Route Tests
 * Tests: ORACLE-007, ORACLE-008, ORACLE-009
 *
 * ORACLE-007: Returns publisher data for pyth-pinned mode
 * ORACLE-008: Returns publisher data for admin mode
 * ORACLE-009: Handles missing/invalid parameters gracefully
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch for Pythnet RPC and oracle bridge calls
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

  it("ORACLE-009: returns 400 for pyth-pinned without feedId", async () => {
    const resp = await GET(makeRequest({ mode: "pyth-pinned" }));
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("feedId");
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

  it("ORACLE-007: parses Pythnet account data for pyth-pinned mode", async () => {
    // Build a minimal Pyth price account buffer:
    //   magic(4) + ver(4) + type(4) + size(4) + ptype(4) + expo(4) +
    //   num_components(4) + num_qt(4) + ...padding... + 2 components
    const buf = Buffer.alloc(208 + 2 * 96); // 2 publishers

    // Magic
    buf.writeUInt32LE(0xa1b2c3d4, 0);
    // Version
    buf.writeUInt32LE(2, 4);
    // Type = 3 (price)
    buf.writeUInt32LE(3, 8);
    // Size
    buf.writeUInt32LE(buf.length, 12);
    // num_components = 2
    buf.writeUInt32LE(2, 24);

    // Component 0: publisher key (32 bytes of 0x01), status = 1 (active)
    for (let i = 0; i < 32; i++) buf[208 + i] = 0x01;
    buf.writeUInt32LE(1, 208 + 64 + 16); // latest status = Trading

    // Component 1: publisher key (32 bytes of 0x02), status = 0 (offline)
    for (let i = 0; i < 32; i++) buf[208 + 96 + i] = 0x02;
    buf.writeUInt32LE(0, 208 + 96 + 64 + 16); // latest status = Unknown

    const base64Data = buf.toString("base64");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          value: {
            data: [base64Data, "base64"],
          },
        },
      }),
    });

    // ETH/USD feed ID (any valid 32-byte hex will do)
    const feedId = "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    const resp = await GET(makeRequest({ mode: "pyth-pinned", feedId }));
    expect(resp.status).toBe(200);

    const body = await resp.json();
    expect(body.mode).toBe("pyth-pinned");
    expect(body.publisherTotal).toBe(2);
    expect(body.publisherCount).toBe(1); // Only 1 active
    expect(body.publishers).toHaveLength(2);
    expect(body.publishers[0].status).toBe("active"); // Active sorted first
    expect(body.publishers[1].status).toBe("offline");
  });

  it("ORACLE-007: returns empty when Pythnet account not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { value: null },
      }),
    });

    const feedId = "0000000000000000000000000000000000000000000000000000000000000001";
    const resp = await GET(makeRequest({ mode: "pyth-pinned", feedId }));
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
    expect(body.publisherCount).toBe(0);
  });
});
