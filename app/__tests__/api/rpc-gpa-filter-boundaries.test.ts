import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Buffer } from "node:buffer";
import bs58 from "bs58";
import { getAllProgramIds } from "@/lib/config";
import { __setSharedUpstreamPoolForTest } from "@/lib/rpc-upstreams";
import { POST } from "../../app/api/rpc/route";

vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: () => ({
    check: async () => ({ allowed: true }),
  }),
}));

describe("RPC GPA decoded-byte boundaries", () => {
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
    if (!program) throw new Error("Missing program ID");

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
          params: [
            program,
            { filters, encoding: "base64" },
          ],
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

  const positive: [string, unknown[]][] = [
    ["explicit base58", [
      { memcmp: { offset: 0, bytes: "2", encoding: "base58" } },
    ]],
    ["128 decoded bytes base58", [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.alloc(128, 1)) } },
    ]],
    ["128 decoded bytes base64", [
      { memcmp: {
        offset: 0,
        bytes: Buffer.alloc(128, 1).toString("base64"),
        encoding: "base64",
      } },
    ]],
    ["multiple valid memcmp filters", [
      { memcmp: { offset: 0, bytes: "2" } },
      { memcmp: { offset: 32, bytes: "2" } },
    ]],
  ];

  const negative: [string, unknown[]][] = [
    ["129 decoded bytes base58", [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.alloc(129, 1)) } },
    ]],
    ["129 decoded bytes base64", [
      { memcmp: {
        offset: 0,
        bytes: Buffer.alloc(129, 1).toString("base64"),
        encoding: "base64",
      } },
    ]],
    ["invalid base64 padding", [
      { memcmp: { offset: 0, bytes: "AQ=", encoding: "base64" } },
    ]],
    ["unexpected memcmp property", [
      { memcmp: { offset: 0, bytes: "2", unexpected: true } },
    ]],
  ];

  it.each(positive)("accepts %s", async (_name, filters) => {
    await check(filters, true);
  });

  it.each(negative)("rejects %s", async (_name, filters) => {
    await check(filters, false);
  });
});
