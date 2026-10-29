import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getAllProgramIds } from "@/lib/config";
import { __setSharedUpstreamPoolForTest } from "@/lib/rpc-upstreams";
import { POST } from "../../app/api/rpc/route";

vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({
    check: async () => ({ allowed: true }),
  }),
}));

describe("RPC GPA filter edge cases", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
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

  async function check(filters: unknown[], accepted: boolean) {
    const program = getAllProgramIds()[0];
    if (!program) throw new Error("Missing configured program");

    const req = new NextRequest(
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
          params: [program, { filters, encoding: "base64" }],
        }),
      },
    );

    const res = await POST(req);

    expect(res.status).toBe(accepted ? 200 : 400);

    if (accepted) {
      expect(fetchMock).toHaveBeenCalled();
    } else {
      expect(fetchMock).not.toHaveBeenCalled();
    }
  }

  it.each([
    ["valid base58", [{ memcmp: { offset: 0, bytes: "2" } }]],
    ["valid base64", [{ memcmp: { offset: 0, bytes: "AQ==", encoding: "base64" } }]],
    ["combined filters", [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: "2" } },
    ]],
  ])("positive: %s", async (_name, filters) => {
    await check(filters, true);
  });

  it.each([
    ["invalid base58", [{ memcmp: { offset: 0, bytes: "0" } }]],
    ["zero-byte base64", [{ memcmp: { offset: 0, bytes: "==", encoding: "base64" } }]],
    ["oversized memcmp", [{ memcmp: { offset: 0, bytes: "1".repeat(129) } }]],
    ["unsupported encoding", [{ memcmp: { offset: 0, bytes: "2", encoding: "hex" } }]],
    ["mixed malformed filter", [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: "" } },
    ]],
    ["negative offset", [{ memcmp: { offset: -1, bytes: "2" } }]],
    ["fractional dataSize", [{ dataSize: 165.5 }]],
    ["unknown field", [{ arbitrary: 123 }]],
  ])("negative: %s", async (_name, filters) => {
    await check(filters, false);
  });
});
