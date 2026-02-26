import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchRpc } from "@/lib/batchRpc";

describe("createBatchRpc", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("batches multiple requests into a single HTTP call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => [
        { jsonrpc: "2.0", result: { value: 1000 }, id: 1 },
        { jsonrpc: "2.0", result: { value: 2000 }, id: 2 },
      ],
      headers: new Headers({ "Content-Type": "application/json" }),
    });
    globalThis.fetch = fetchMock;

    const { enqueue } = createBatchRpc({
      endpoint: "http://localhost/api/rpc",
      batchWindowMs: 10,
    });

    const p1 = enqueue("getBalance", ["addr1"]);
    const p2 = enqueue("getBalance", ["addr2"]);

    // Advance timer to trigger flush
    await vi.advanceTimersByTimeAsync(20);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Should have made only 1 fetch call
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Verify batch payload
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0].method).toBe("getBalance");
    expect(body[1].method).toBe("getBalance");

    // Verify individual responses
    const parsed1 = JSON.parse(r1);
    const parsed2 = JSON.parse(r2);
    expect(parsed1.result.value).toBe(1000);
    expect(parsed2.result.value).toBe(2000);
  });

  it("deduplicates identical requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => [
        { jsonrpc: "2.0", result: { value: 42 }, id: 1 },
      ],
      headers: new Headers({ "Content-Type": "application/json" }),
    });
    globalThis.fetch = fetchMock;

    const { enqueue } = createBatchRpc({
      endpoint: "http://localhost/api/rpc",
      batchWindowMs: 10,
    });

    // Enqueue the exact same request twice
    const p1 = enqueue("getBalance", ["sameAddr"]);
    const p2 = enqueue("getBalance", ["sameAddr"]);

    await vi.advanceTimersByTimeAsync(20);

    const [r1, r2] = await Promise.all([p1, p2]);

    // Should have sent only 1 request in the batch (deduplication)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toHaveLength(1);

    // Both callers get the same result
    expect(JSON.parse(r1).result.value).toBe(42);
    expect(JSON.parse(r2).result.value).toBe(42);
  });

  it("flushes immediately when batch size is reached", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      json: async () =>
        Array.from({ length: 3 }, (_, i) => ({
          jsonrpc: "2.0",
          result: i,
          id: i + 1,
        })),
      headers: new Headers({ "Content-Type": "application/json" }),
    });
    globalThis.fetch = fetchMock;

    const { enqueue } = createBatchRpc({
      endpoint: "http://localhost/api/rpc",
      batchWindowMs: 5000, // Long window — shouldn't matter
      maxBatchSize: 3,
    });

    // Enqueue exactly maxBatchSize requests
    const promises = [
      enqueue("getSlot", []),
      enqueue("getHealth", []),
      enqueue("getVersion", []),
    ];

    // Should flush immediately without waiting for timer
    // Advance just a bit to allow microtask to complete
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(promises);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries with exponential backoff on 429", async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          status: 429,
          headers: new Headers({ "Retry-After": "1" }),
          text: async () => "rate limited",
        };
      }
      return {
        status: 200,
        json: async () => [{ jsonrpc: "2.0", result: "ok", id: 1 }],
        headers: new Headers({ "Content-Type": "application/json" }),
      };
    });
    globalThis.fetch = fetchMock;

    const { enqueue } = createBatchRpc({
      endpoint: "http://localhost/api/rpc",
      batchWindowMs: 10,
      initialBackoffMs: 100,
      maxRetries: 5,
    });

    const p = enqueue("getSlot", []);

    // Advance timers to trigger flush + retries
    await vi.advanceTimersByTimeAsync(10); // flush
    await vi.advanceTimersByTimeAsync(2000); // retry 1
    await vi.advanceTimersByTimeAsync(3000); // retry 2

    const result = JSON.parse(await p);
    expect(result.result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  describe("batchFetch", () => {
    it("intercepts RPC POST requests", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => [
          { jsonrpc: "2.0", result: { value: 100 }, id: 1 },
        ],
        headers: new Headers({ "Content-Type": "application/json" }),
      });
      globalThis.fetch = fetchMock;

      const { batchFetch } = createBatchRpc({
        endpoint: "http://localhost/api/rpc",
        batchWindowMs: 10,
      });

      const responsePromise = batchFetch("http://localhost/api/rpc", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["addr"] }),
      });

      await vi.advanceTimersByTimeAsync(20);

      const response = await responsePromise;
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.result.value).toBe(100);
    });

    it("passes through non-RPC requests", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock;

      const { batchFetch } = createBatchRpc({
        endpoint: "http://localhost/api/rpc",
        batchWindowMs: 10,
      });

      await batchFetch("http://localhost/api/markets", { method: "GET" });

      // Should have called native fetch directly
      expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/markets", { method: "GET" });
    });
  });
});
