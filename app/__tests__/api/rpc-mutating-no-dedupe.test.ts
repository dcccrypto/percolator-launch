import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/rpc/route";

/**
 * #2755: sendTransaction / simulateTransaction must never be deduplicated.
 * MUTATING_METHODS was an empty set, so two concurrent identical
 * sendTransaction calls collapsed into ONE upstream request and both callers
 * shared the first response (a retry or second-signer submit never reached the
 * cluster).
 */
describe("/api/rpc mutating methods are not deduplicated (#2755)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    let n = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      const id = ++n;
      // Yield so the second request starts while the first is still in flight.
      await new Promise((r) => setTimeout(r, 10));
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result: `sig-${id}` }) } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeReq(method: string, id: number): NextRequest {
    return new NextRequest("http://localhost/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://api.percolatorlaunch.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: ["AAAA", { encoding: "base64" }] }),
    });
  }

  for (const method of ["sendTransaction", "simulateTransaction"]) {
    it(`two concurrent identical ${method} calls each reach upstream`, async () => {
      const [a, b] = await Promise.all([POST(makeReq(method, 1)), POST(makeReq(method, 2))]);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const ja = (await a.json()) as { result: string };
      const jb = (await b.json()) as { result: string };
      expect(ja.result).not.toBe(jb.result);
    });
  }

  it("still deduplicates concurrent identical read-only calls", async () => {
    await Promise.all([POST(makeReq("getEpochInfo", 1)), POST(makeReq("getEpochInfo", 2))]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
