import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/rpc/route";

describe("/api/rpc origin guard", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "ok" }),
    } as Response) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeReq(origin: string): NextRequest {
    return new NextRequest("http://localhost/api/rpc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
        params: [],
      }),
    });
  }

  it("blocks lookalike hostnames that only contain allowed domain as substring", async () => {
    const req = makeReq("https://evilpercolatorlaunch.com");
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("allows valid first-party subdomains", async () => {
    const req = makeReq("https://api.percolatorlaunch.com");
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("/api/rpc no-Origin server-call gate", () => {
  const originalFetch = global.fetch;
  const originalSecret = process.env.INTERNAL_API_SECRET;
  const SECRET = "test-internal-secret-do-not-use-in-prod";

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ jsonrpc: "2.0", id: 1, result: "ok" }),
    } as Response) as typeof fetch;
    process.env.INTERNAL_API_SECRET = SECRET;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalSecret === undefined) {
      delete process.env.INTERNAL_API_SECRET;
    } else {
      process.env.INTERNAL_API_SECRET = originalSecret;
    }
  });

  // Cache-busting counter — the route caches getHealth responses for 5s with
  // a module-level Map keyed on method+params, so reuse across tests would
  // skip fetch. Each test gets a unique sentinel in params.
  let nextParam = 1000;
  function makeReq(headers: Record<string, string> = {}, body?: unknown): NextRequest {
    nextParam += 1;
    return new NextRequest("http://localhost/api/rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(
        body ?? {
          jsonrpc: "2.0",
          id: nextParam,
          method: "getHealth",
          params: [`test-${nextParam}`],
        },
      ),
    });
  }

  it("rejects POST with no Origin AND no Referer AND no token (the original bypass)", async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error.message).toBe("Forbidden");
  });

  it("rejects no-Origin POST with the wrong token", async () => {
    const res = await POST(makeReq({ "x-internal-token": "wrong" }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects no-Origin POST with an empty-string token", async () => {
    const res = await POST(makeReq({ "x-internal-token": "" }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("accepts no-Origin POST with the correct X-Internal-Token", async () => {
    const res = await POST(makeReq({ "x-internal-token": SECRET }));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when INTERNAL_API_SECRET is unset (no token can succeed)", async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = await POST(makeReq({ "x-internal-token": SECRET }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when INTERNAL_API_SECRET is an empty string", async () => {
    process.env.INTERNAL_API_SECRET = "";
    const res = await POST(makeReq({ "x-internal-token": SECRET }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when INTERNAL_API_SECRET is whitespace-only", async () => {
    process.env.INTERNAL_API_SECRET = "   ";
    // Whitespace .trim() reduces to empty → fail closed even if a token literally matches the untrimmed value.
    const res = await POST(makeReq({ "x-internal-token": "   " }));
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("regression: closes the high-impact sendTransaction relay path", async () => {
    // The original bypass let anonymous callers broadcast arbitrary signed
    // transactions through the project's paid Helius mainnet key.
    const res = await POST(
      makeReq(
        {},
        { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["<base64-tx>"] },
      ),
    );
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("browser path is unaffected: Origin: percolatorlaunch.com still passes without a token", async () => {
    const res = await POST(makeReq({ origin: "https://percolatorlaunch.com" }));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("browser path is unaffected: Referer-only with valid hostname still passes without a token", async () => {
    const res = await POST(
      makeReq({ referer: "https://app.percolatorlaunch.com/trade" }),
    );
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
