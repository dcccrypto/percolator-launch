import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getAllProgramIds } from "@/lib/config";
import { __setSharedUpstreamPoolForTest } from "@/lib/rpc-upstreams";
import { POST } from "../../app/api/rpc/route";

vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({
    check: async () => ({ allowed: true }),
  }),
}));

describe("RPC GPA memcmp bytes are length-capped BEFORE decoding (#3696 follow-up)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: [],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);
    __setSharedUpstreamPoolForTest(null);
  });

  afterEach(() => {
    __setSharedUpstreamPoolForTest(null);
    vi.unstubAllGlobals();
  });

  function allowedProgram(): string {
    const id = getAllProgramIds()[0];
    if (!id) throw new Error("No configured program ID");
    return id;
  }

  function request(program: string, filters: unknown[]) {
    return new NextRequest(
      "https://percolatorlaunch.com/api/rpc",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://percolatorlaunch.com",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getProgramAccounts",
          params: [
            program,
            { filters, encoding: "base64" },
          ],
        }),
      },
    );
  }

  // bs58.decode is ~quadratic: a 200k-char string costs ~20 s of CPU, and a 4.5 MB body could
  // hold a function for minutes. A valid memcmp (<= 128 decoded bytes) is at most 175 base58 or
  // 172 base64 chars, so anything longer is refused on length alone.
  it("refuses a 200k-char base58 memcmp quickly, without decoding it", async () => {
    const t = performance.now();
    const res = await POST(request(allowedProgram(), [{ memcmp: { offset: 0, bytes: "z".repeat(200_000) } }]));
    const ms = performance.now() - t;
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ms).toBeLessThan(1_000);
  }, 60_000);

  it("refuses a 200k-char base64 memcmp quickly", async () => {
    const t = performance.now();
    const res = await POST(request(allowedProgram(), [{ memcmp: { offset: 0, bytes: "A".repeat(200_000), encoding: "base64" } }]));
    expect(res.status).toBe(400);
    expect(performance.now() - t).toBeLessThan(1_000);
  }, 60_000);

  it("still accepts the longest valid forms: 128 bytes as base58 (all 0xff) and as base64", async () => {
    const ff = new Uint8Array(128).fill(255);
    const b58 = (await import("bs58")).default.encode(ff);
    expect(b58.length).toBeLessThanOrEqual(175);
    expect((await POST(request(allowedProgram(), [{ memcmp: { offset: 0, bytes: b58 } }]))).status).toBe(200);
    const b64 = Buffer.from(ff).toString("base64");
    expect((await POST(request(allowedProgram(), [{ memcmp: { offset: 0, bytes: b64, encoding: "base64" } }]))).status).toBe(200);
    // 128 zero bytes are 128 leading "1"s in base58
    expect((await POST(request(allowedProgram(), [{ memcmp: { offset: 0, bytes: "1".repeat(128) } }]))).status).toBe(200);
  });
});
