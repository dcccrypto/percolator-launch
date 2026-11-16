import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reportRpcOutcome = vi.fn();
vi.mock("@/lib/rpc-health", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rpc-health")>("@/lib/rpc-health");
  return { ...actual, reportRpcOutcome: (...a: unknown[]) => reportRpcOutcome(...a) };
});

import { createBatchRpc, getBatchRpc, invalidateRpcReadDedupe } from "@/lib/batchRpc";
import { RPC_MAX_BATCH_SIZE } from "@/lib/rpc-limits";

const EP = "http://localhost/api/rpc";
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  headers: new Headers(),
});
const status = (s: number, headers: Record<string, string> = {}) => ({
  ok: s >= 200 && s < 300,
  status: s,
  json: async () => {
    throw new SyntaxError("Unexpected end of JSON input");
  },
  headers: new Headers(headers),
});

describe("batchRpc failure handling", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    reportRpcOutcome.mockClear();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("partial batch: a missing id resolves a JSON-RPC error for that caller only (not null/empty)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(
      ok([null, { jsonrpc: "2.0", result: "A", id: 1 }, { jsonrpc: "2.0", result: "nullid", id: null }]),
    );
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
    const p1 = enqueue("getAccountInfo", ["a"]);
    const p2 = enqueue("getAccountInfo", ["b"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(await p1).result).toBe("A");
    const missing = JSON.parse(await p2);
    expect(missing.result).toBeUndefined();
    expect(missing.error).toEqual({ code: -32603, message: "Missing response from batch" });
    expect(missing.id).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Missing responses for IDs: 2"));
  });

  it("non-array response to a single-item batch is passed through", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ jsonrpc: "2.0", result: 7, id: 1 }));
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
    const p = enqueue("getAccountInfo", ["a"]);
    await vi.advanceTimersByTimeAsync(20);
    expect(JSON.parse(await p).result).toBe(7);
  });

  it("non-array response to a multi-item batch errors every caller", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ oops: true }));
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
    const p1 = enqueue("getAccountInfo", ["a"]);
    const p2 = enqueue("getAccountInfo", ["b"]);
    await vi.advanceTimersByTimeAsync(20);
    for (const [i, p] of [p1, p2].entries()) {
      const r = JSON.parse(await p);
      expect(r.error).toEqual({ code: -32603, message: "Unexpected non-array response" });
      expect(r.id).toBe(i + 1);
    }
  });

  it("429 exhaustion resolves a -32005 error for all callers (then gives up)", async () => {
    const f = vi.fn().mockResolvedValue(status(429, { "Retry-After": "1" }));
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, maxRetries: 1, initialBackoffMs: 5 });
    const p1 = enqueue("getAccountInfo", ["a"]);
    const p2 = enqueue("getAccountInfo", ["b"]);
    await vi.advanceTimersByTimeAsync(5000);
    for (const p of [p1, p2]) {
      const r = JSON.parse(await p);
      expect(r.error.code).toBe(-32005);
    }
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("other 4xx rejects the chunk without retrying", async () => {
    const f = vi.fn().mockResolvedValue(status(413));
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
    const p = enqueue("getAccountInfo", ["a"]);
    const assertion = expect(p).rejects.toThrow("HTTP 413");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("5xx retries maxServerErrorRetries then rejects with the HTTP error", async () => {
    const f = vi.fn().mockResolvedValue(status(502));
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, initialBackoffMs: 5, maxServerErrorRetries: 2 });
    const p = enqueue("getAccountInfo", ["a"]);
    const assertion = expect(p).rejects.toThrow("HTTP 502");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("network failure that recovers on retry resolves normally", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(ok([{ jsonrpc: "2.0", result: 1, id: 1 }]));
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, initialBackoffMs: 5 });
    const p = enqueue("getAccountInfo", ["a"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(await p).result).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("non-Error throw is wrapped into an Error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue("boom");
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, maxServerErrorRetries: 0 });
    const p = enqueue("getAccountInfo", ["a"]);
    const assertion = expect(p).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("failed chunk rejects its callers (never a silent empty result); the other chunk still resolves", async () => {
    const n = RPC_MAX_BATCH_SIZE;
    const f = vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number }[];
      if (body.some((b) => b.id === 1)) return status(400);
      return ok(body.map((b) => ({ jsonrpc: "2.0", result: b.id, id: b.id })));
    });
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, maxBatchSize: n, maxQueueSize: 10_000 });
    // n+1 reads: the first n flush together when the cap is hit, the last goes alone after the window
    const ps = Array.from({ length: n + 1 }, (_, i) => enqueue("getAccountInfo", [`k${i}`]));
    const settled = ps.map((p) => p.then((v) => ({ v }), (e: Error) => ({ e })));
    await vi.advanceTimersByTimeAsync(100);
    const out = await Promise.all(settled);
    expect(out.slice(0, n).every((o) => "e" in o && /HTTP 400/.test((o as { e: Error }).e.message))).toBe(true);
    expect(JSON.parse((out[n] as { v: string }).v).result).toBe(n + 1);
  });

  it("maxBatchSize floors at 1", async () => {
    const f = vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number }[];
      return ok(body.map((b) => ({ jsonrpc: "2.0", result: b.id, id: b.id })));
    });
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({ endpoint: EP, batchWindowMs: 10, maxBatchSize: 0 });
    const ps = [enqueue("getAccountInfo", ["a"]), enqueue("getAccountInfo", ["b"])];
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(ps);
    expect(f).toHaveBeenCalledTimes(2);
    for (const c of f.mock.calls) expect(JSON.parse(c[1].body)).toHaveLength(1);
  });

  it("a failed batch starts a cooldown; reads queue until it ends, then flush", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok([{ jsonrpc: "2.0", result: "late", id: 2 }]));
    globalThis.fetch = f;
    const { enqueue } = createBatchRpc({
      endpoint: EP,
      batchWindowMs: 10,
      maxServerErrorRetries: 0,
      initialBackoffMs: 1000,
    });
    const p1 = enqueue("getAccountInfo", ["a"]);
    const a1 = expect(p1).rejects.toThrow("HTTP 503");
    await vi.advanceTimersByTimeAsync(20);
    await a1;
    // Within cooldown: a new read queues and does not fire
    const p2 = enqueue("getAccountInfo", ["b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(JSON.parse(await p2).result).toBe("late");
    expect(f).toHaveBeenCalledTimes(2);
  });

  describe("batchFetch", () => {
    const post = (body: unknown, extra: RequestInit = {}) => ({
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...extra,
    });

    it("restores the caller's id and reports a healthy outcome", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(ok([{ jsonrpc: "2.0", result: 5, id: 1 }]));
      const { batchFetch } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const pr = batchFetch(EP, post({ jsonrpc: "2.0", id: "uuid-1", method: "getAccountInfo", params: ["a"] }));
      await vi.advanceTimersByTimeAsync(20);
      const res = await pr;
      expect(await res.json()).toMatchObject({ id: "uuid-1", result: 5 });
      expect(reportRpcOutcome).toHaveBeenCalledWith(true, null);
    });

    it("leaves the id alone when the caller sent none", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(ok([{ jsonrpc: "2.0", result: 5, id: 1 }]));
      const { batchFetch } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const pr = batchFetch(new URL(EP), post({ method: "getAccountInfo", params: ["a"] }));
      await vi.advanceTimersByTimeAsync(20);
      expect((await (await pr).json()).id).toBe(1);
    });

    it("accepts a Request input and a Uint8Array body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(ok([{ jsonrpc: "2.0", result: 9, id: 1 }]));
      const { batchFetch } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const body = new TextEncoder().encode(JSON.stringify({ id: "x", method: "getAccountInfo" }));
      const pr = batchFetch(new Request(EP, { method: "POST", body: "{}" }), { method: "POST", body });
      await vi.advanceTimersByTimeAsync(20);
      expect(await (await pr).json()).toMatchObject({ id: "x", result: 9 });
    });

    it("reports an unhealthy outcome for rate-limit errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(ok([{ jsonrpc: "2.0", error: { code: -32005, message: "x" }, id: 1 }]));
      const { batchFetch } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const pr = batchFetch(EP, post({ id: 1, method: "getAccountInfo", params: [] }));
      await vi.advanceTimersByTimeAsync(20);
      await pr;
      expect(reportRpcOutcome).toHaveBeenCalledWith(false, -32005);
    });

    it("reports a transport failure and rethrows", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(status(400));
      const { batchFetch } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const pr = batchFetch(EP, post({ id: 1, method: "getAccountInfo", params: [] }));
      const assertion = expect(pr).rejects.toThrow("HTTP 400");
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(reportRpcOutcome).toHaveBeenCalledWith(false);
    });

    it("passes through unbatchable methods, GET, bodiless, bad JSON, arrays and method-less bodies", async () => {
      const f = vi.fn().mockResolvedValue(new Response("{}"));
      globalThis.fetch = f;
      const { batchFetch } = createBatchRpc({ endpoint: EP });
      await batchFetch(EP, post({ id: 1, method: "sendTransaction", params: [] }));
      await batchFetch(EP, { method: "GET" });
      await batchFetch(EP, { method: "POST" });
      await batchFetch(EP, post("not json"));
      await batchFetch(EP, post([{ id: 1, method: "getAccountInfo" }]));
      await batchFetch(EP, post({ id: 1 }));
      expect(f).toHaveBeenCalledTimes(6);
    });

    it("matches /api/rpc?query URLs", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(ok([{ jsonrpc: "2.0", result: 1, id: 1 }]));
      const { batchFetch } = createBatchRpc({ endpoint: "http://other/rpc", batchWindowMs: 10 });
      const pr = batchFetch("http://x/api/rpc?foo=1", post({ id: 1, method: "getAccountInfo", params: [] }));
      await vi.advanceTimersByTimeAsync(20);
      expect((await pr).status).toBe(200);
    });
  });

  describe("invalidateInflightDedupe", () => {
    it("keeps queued reads deduping but drops sent ones", async () => {
      const f = vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { id: number }[];
        return ok(body.map((b) => ({ jsonrpc: "2.0", result: b.id, id: b.id })));
      });
      globalThis.fetch = f;
      const { enqueue, invalidateInflightDedupe } = createBatchRpc({ endpoint: EP, batchWindowMs: 10 });
      const a = enqueue("getAccountInfo", ["a"]);
      expect(enqueue("getAccountInfo", ["a"])).toBe(a);
      invalidateInflightDedupe();
      expect(enqueue("getAccountInfo", ["a"])).toBe(a);
      await vi.advanceTimersByTimeAsync(20);
      await a;
    });
  });

  describe("singleton", () => {
    it("throws without window, then builds one instance and invalidates it", async () => {
      expect(() => invalidateRpcReadDedupe()).not.toThrow(); // no instance yet
      vi.stubGlobal("window", undefined);
      expect(() => getBatchRpc()).toThrow("only available on the client");
      vi.stubGlobal("window", { location: { origin: "http://localhost" } });
      const a = getBatchRpc();
      expect(getBatchRpc()).toBe(a);
      expect(() => invalidateRpcReadDedupe()).not.toThrow();
    });
  });
});
