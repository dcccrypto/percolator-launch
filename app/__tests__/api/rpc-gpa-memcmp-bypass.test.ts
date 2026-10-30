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

describe("RPC GPA memcmp encoding bypass attempts (app-a 2026-10-30)", () => {
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

  const m = (bytes: unknown, encoding?: unknown, offset: unknown = 0) => [{ memcmp: { offset, bytes, encoding } }];
  const negative: [string, unknown[]][] = [
    ["base58 with a '0' (not in alphabet)", m("0")],
    ["base58 with 'l'", m("l")],
    ["175 leading-zero chars decode to 175 bytes", m("1".repeat(175))],
    ["176 chars (cap before decode)", m("2".repeat(176))],
    ["base64 with newline", m("AAAA\nAAAA", "base64")],
    ["base64 with space", m("AAAA AAAA", "base64")],
    ["base64 url-safe alphabet", m("-_-_", "base64")],
    ["base64 non-canonical trailing bits", m("AB==", "base64")],
    ["base64 empty", m("", "base64")],
    ["base58 empty", m("")],
    ["bytes as number array", m([1, 2, 3])],
    ["bytes as number", m(5)],
    ["encoding bytes (legacy)", m("2", "bytes")],
    ["encoding uppercase", m("AAAA", "BASE64")],
    ["encoding null", m("2", null)],
    ["offset negative", m("2", undefined, -1)],
    ["offset float", m("2", undefined, 1.5)],
    ["offset string", m("2", undefined, "0")],
    ["offset beyond safe integer", m("2", undefined, 2 ** 60)],
    ["unicode lookalike", m("\u0661")],
    ["dataSize negative", [{ dataSize: -1 }]],
    ["dataSize float", [{ dataSize: 1.5 }]],
    ["dataSize string", [{ dataSize: "165" }]],
    ["dataSize + memcmp in one object", [{ dataSize: 10, memcmp: { offset: 0, bytes: "2" } }]],
    ["empty filter object", [{}]],
    ["null filter", [null]],
    ["array filter", [[{ dataSize: 1 }]]],
    ["a bad filter next to a good one", [{ dataSize: 10 }, { memcmp: { offset: 0, bytes: "" } }]],
    ["empty filters", []],
  ];
  const positive: [string, unknown[]][] = [
    ["dataSize only (SDK discovery)", [{ dataSize: 1_000_000 }]],
    ["dataSize 0", [{ dataSize: 0 }]],
    ["175-char base58 that decodes to <=128 bytes? (128 x 0xff)", m(bs58.encode(Buffer.alloc(128, 255)))],
    ["canonical base64 padded 1 byte", m("AQ==", "base64")],
    ["huge but safe offset", m("2", undefined, Number.MAX_SAFE_INTEGER)],
  ];
  it.each(positive)("accepts %s", async (_n, f) => { await check(f, true); });
  it.each(negative)("rejects %s", async (_n, f) => { await check(f, false); });
});
