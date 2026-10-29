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

describe("RPC GPA filter hardening", () => {
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

  it("negative: rejects missing filters", async () => {
    const res = await POST(request(allowedProgram(), []));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("negative: rejects foreign programs", async () => {
    const res = await POST(
      request(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        [{ dataSize: 165 }],
      ),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("positive: accepts valid dataSize", async () => {
    const res = await POST(
      request(allowedProgram(), [{ dataSize: 165 }]),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("regression: rejects empty memcmp bytes", async () => {
    const res = await POST(
      request(allowedProgram(), [
        { memcmp: { offset: 0, bytes: "" } },
      ]),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
