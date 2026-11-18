/**
 * /api/rpc per-IP limiter must fail CLOSED on a bad RPC_RATE_LIMIT_PER_WINDOW.
 * Only the explicit value "off" disables it; unset/blank/garbage/0/negative/
 * fractional fall back to the default 200 with a console warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const check = vi.fn();
const create = vi.fn();
vi.mock("@/lib/upstash-rate-limit", () => ({
  createUpstashRateLimiter: (opts: unknown) => {
    create(opts);
    return { check };
  },
}));

type PostFn = (req: NextRequest) => Promise<Response>;

async function load(value: string | undefined): Promise<PostFn> {
  vi.resetModules();
  if (value === undefined) delete process.env.RPC_RATE_LIMIT_PER_WINDOW;
  else process.env.RPC_RATE_LIMIT_PER_WINDOW = value;
  return ((await import("../../app/api/rpc/route")) as unknown as { POST: PostFn }).POST;
}

function req(): NextRequest {
  return new NextRequest("http://localhost/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
  });
}

describe("/api/rpc RPC_RATE_LIMIT_PER_WINDOW parsing", () => {
  const saved = process.env.RPC_RATE_LIMIT_PER_WINDOW;
  const originalFetch = global.fetch;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    check.mockReset().mockResolvedValue({ allowed: true, remaining: 1, retryAfterSecs: 0 });
    create.mockReset();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: 1 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    warn.mockRestore();
    global.fetch = originalFetch;
    if (saved === undefined) delete process.env.RPC_RATE_LIMIT_PER_WINDOW;
    else process.env.RPC_RATE_LIMIT_PER_WINDOW = saved;
  });

  it.each([
    ["unset", undefined],
    ["empty string", ""],
    ["whitespace", "  "],
    ["'0'", "0"],
    ["negative", "-5"],
    ["typo '200/10s'", "200/10s"],
    ["'abc'", "abc"],
    ["'NaN'", "NaN"],
    ["'Infinity'", "Infinity"],
    ["fractional '0.5'", "0.5"],
    ["scientific notation", "1e21"],
  ])("%s -> limiter stays ON with default 200", async (_n, value) => {
    const POST = await load(value);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    await POST(req());
    expect(check).toHaveBeenCalledTimes(1);
    if (value !== undefined) expect(warn).toHaveBeenCalled();
  });

  it("a valid positive integer is used as-is", async () => {
    const POST = await load("50");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    await POST(req());
    expect(check).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["off", "OFF", " off "])("explicit %j disables the limiter", async (value) => {
    const POST = await load(value);
    await POST(req());
    expect(check).not.toHaveBeenCalled();
  });

  it("denied limiter result -> 429", async () => {
    check.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSecs: 3 });
    const POST = await load("abc");
    const res = await POST(req());
    expect(res.status).toBe(429);
  });
});
