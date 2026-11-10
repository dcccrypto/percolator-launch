// Council r4 R3-8: RPC amplification. Counts JSON-RPC items that actually leave the browser
// over a fake-timer window, and checks failure backoff is capped + exponential.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBatchRpc } from "@/lib/batchRpc";

const ENDPOINT = "http://localhost/api/rpc";

interface Sent {
  at: number;
  method: string;
  key: string;
}

let sent: Sent[] = [];
let httpCalls = 0;
let mode: "ok" | "fail" = "ok";
let latencyMs = 600;
let t0 = 0;

function installFetch() {
  httpCalls = 0;
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      httpCalls++;
      const items = JSON.parse(String(init?.body)) as Array<{ id: number; method: string; params: unknown }>;
      for (const it of items) sent.push({ at: Date.now() - t0, method: it.method, key: `${it.method}:${JSON.stringify(it.params)}` });
      await new Promise((r) => setTimeout(r, latencyMs));
      if (mode === "fail") return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify(items.map((i) => ({ jsonrpc: "2.0", id: i.id, result: { value: null } }))), { status: 200 });
    }),
  );
}

function call(rpc: ReturnType<typeof createBatchRpc>, method: string, params: unknown[]) {
  return rpc
    .batchFetch(ENDPOINT, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: "abc", method, params }) })
    .then((r) => r.json())
    .catch(() => null);
}

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  mode = "ok";
  latencyMs = 600;
  installFetch();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("R3-8 idle /trade RPC volume", () => {
  it("four consumers polling the same account every 2.5s for 300s send ~one read per tick", async () => {
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 100, maxBatchSize: 40 });
    const stagger = [0, 120, 240, 350]; // consumers land outside one another's 100ms window
    for (const off of stagger) {
      const run = () => void call(rpc, "getAccountInfo", ["SLAB", { encoding: "base64" }]);
      setTimeout(() => {
        run();
        setInterval(run, 2500);
      }, off);
    }
    await vi.advanceTimersByTimeAsync(300_000);
    const reads = sent.filter((s) => s.method === "getAccountInfo").length;
    // 120 ticks * 4 consumers = 480 before the fix; one per tick (+ boundary slack) after.
    expect(reads).toBeLessThanOrEqual(130);
  });

  it("a read issued while an identical read is in flight joins it", async () => {
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 100, maxBatchSize: 40 });
    void call(rpc, "getAccountInfo", ["A"]);
    await vi.advanceTimersByTimeAsync(300); // first batch is now on the wire (600ms latency)
    const second = call(rpc, "getAccountInfo", ["A"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent.filter((s) => s.key.includes('["A"]'))).toHaveLength(1);
    expect(await second).toMatchObject({ id: "abc" }); // caller's own id is restored
  });

  it("never dedupes across settled requests (a fresh read after completion goes out)", async () => {
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 100, maxBatchSize: 40 });
    await Promise.all([call(rpc, "getAccountInfo", ["A"]), vi.advanceTimersByTimeAsync(1500)]);
    await Promise.all([call(rpc, "getAccountInfo", ["A"]), vi.advanceTimersByTimeAsync(1500)]);
    expect(sent.filter((s) => s.method === "getAccountInfo")).toHaveLength(2);
  });

  it("does not extend dedupe to the blockhash path", async () => {
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 100, maxBatchSize: 40 });
    void call(rpc, "getLatestBlockhash", [{}]);
    await vi.advanceTimersByTimeAsync(300);
    void call(rpc, "getLatestBlockhash", [{}]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.filter((s) => s.method === "getLatestBlockhash")).toHaveLength(2);
  });
});

describe("R3-8 retry storm under RPC failure", () => {
  it("a poll every 100ms against a dead RPC for 120s makes a bounded number of HTTP attempts", async () => {
    mode = "fail";
    latencyMs = 50;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 100, maxBatchSize: 40 });
    const timer = setInterval(() => void call(rpc, "getAccountInfo", ["SLAB"]), 100);
    await vi.advanceTimersByTimeAsync(120_000);
    clearInterval(timer);
    expect(httpCalls).toBeLessThanOrEqual(40);
  });

  it("backoff grows exponentially and is capped", async () => {
    mode = "fail";
    latencyMs = 10;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 50, maxBatchSize: 40, initialBackoffMs: 1000, maxBackoffMs: 8000 });
    const timer = setInterval(() => void call(rpc, "getAccountInfo", ["SLAB"]), 200);
    await vi.advanceTimersByTimeAsync(180_000);
    clearInterval(timer);
    const starts = sent.map((s) => s.at);
    const gaps = starts.slice(1).map((v, i) => v - starts[i]).filter((g) => g > 400);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8000 + 3000); // cap (+ retry jitter slack)
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(4000); // actually grew
  });

  it("recovers: first success clears the backoff", async () => {
    mode = "fail";
    latencyMs = 10;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 50, maxBatchSize: 40, initialBackoffMs: 1000, maxBackoffMs: 8000 });
    void call(rpc, "getAccountInfo", ["SLAB"]);
    await vi.advanceTimersByTimeAsync(30_000);
    mode = "ok";
    const p = call(rpc, "getAccountInfo", ["SLAB"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ result: { value: null } });
    const before = httpCalls;
    const q = call(rpc, "getAccountInfo", ["OTHER"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await q).toMatchObject({ id: "abc" });
    expect(httpCalls).toBe(before + 1);
  });
});
