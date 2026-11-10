// Council r5 #1: after an outage the queue outgrew the /api/rpc batch cap, the oversized
// batch was rejected with 400, and that counted as another failure -> permanent failure loop.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchRpc } from "@/lib/batchRpc";
import { RPC_MAX_BATCH_SIZE } from "@/lib/rpc-limits";

const ENDPOINT = "http://localhost/api/rpc";

type Body = { id: number; method: string; params: unknown[] }[];

function okResponse(body: Body) {
  return {
    ok: true,
    status: 200,
    json: async () => body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: { v: b.params[0] } })),
    headers: new Headers(),
  };
}
function status(code: number) {
  return { ok: false, status: code, json: async () => ({}), headers: new Headers() };
}

/** Mimics /api/rpc: 400 for batches above the cap, otherwise delegates. */
function serverLike(sizes: number[], healthy: () => boolean, extra?: (body: Body) => unknown) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Body;
    sizes.push(body.length);
    if (body.length > RPC_MAX_BATCH_SIZE) return status(400);
    if (!healthy()) return status(503);
    return extra?.(body) ?? okResponse(body);
  });
}

describe("batchRpc chunking and outage recovery", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  async function outageThenQueue(n: number, healthy: { v: boolean }, sizes: number[], extra?: (b: Body) => unknown) {
    globalThis.fetch = serverLike(sizes, () => healthy.v, extra) as unknown as typeof fetch;
    // maxBatchSize deliberately above the server cap: the client must still never exceed it.
    const rpc = createBatchRpc({
      endpoint: ENDPOINT,
      batchWindowMs: 50,
      maxBatchSize: 1000,
      initialBackoffMs: 1000,
      maxBackoffMs: 4000,
      maxServerErrorRetries: 0,
    });
    // Trigger an outage failure so a backoff is active.
    const first = rpc.enqueue("getAccountInfo", ["first"]).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60);
    expect(await first).toBeInstanceOf(Error);
    // Queue many reads while backing off.
    const ps = Array.from({ length: n }, (_, i) => rpc.enqueue("getAccountInfo", [`k${i}`]));
    return { rpc, ps };
  }

  it("(a) splits >cap queued reads into chunks each <= cap", async () => {
    const sizes: number[] = [];
    const healthy = { v: false };
    const { ps } = await outageThenQueue(130, healthy, sizes);
    sizes.length = 0;
    healthy.v = true;
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(ps);
    expect(sizes.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RPC_MAX_BATCH_SIZE);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(130);
  });

  it("(b) queued reads resolve once the RPC recovers", async () => {
    const sizes: number[] = [];
    const healthy = { v: false };
    const { ps } = await outageThenQueue(95, healthy, sizes);
    healthy.v = true;
    await vi.advanceTimersByTimeAsync(5000);
    const results = await Promise.all(ps);
    expect(results).toHaveLength(95);
    expect(JSON.parse(results[94]).result.v).toBe("k94");
  });

  it("(c) one bad chunk does not fail the other chunks nor extend the backoff", async () => {
    const sizes: number[] = [];
    const healthy = { v: false };
    let call = 0;
    const { rpc, ps } = await outageThenQueue(100, healthy, sizes, (body) => {
      call++;
      return call === 2 ? status(400) : okResponse(body);
    });
    healthy.v = true;
    const settled = ps.map((p) => p.then(() => "ok" as const, () => "err" as const));
    await vi.advanceTimersByTimeAsync(5000);
    const out = await Promise.all(settled);
    expect(out.filter((o) => o === "err")).toHaveLength(RPC_MAX_BATCH_SIZE);
    expect(out.filter((o) => o === "ok")).toHaveLength(60);

    // A request-shape 4xx is not an outage: a later read goes out within the normal window.
    const later = rpc.enqueue("getAccountInfo", ["later"]);
    await vi.advanceTimersByTimeAsync(60);
    expect(JSON.parse(await later).result.v).toBe("later");
  });

  it("bounds the queue by rejecting the oldest reads", async () => {
    globalThis.fetch = vi.fn(async () => status(503)) as unknown as typeof fetch;
    const rpc = createBatchRpc({
      endpoint: ENDPOINT, batchWindowMs: 50, maxBatchSize: 40, initialBackoffMs: 60_000,
      maxServerErrorRetries: 0, maxQueueSize: 10,
    });
    const first = rpc.enqueue("getAccountInfo", ["x"]).catch(() => null);
    await vi.advanceTimersByTimeAsync(60);
    await first;
    const ps = Array.from({ length: 15 }, (_, i) => rpc.enqueue("getAccountInfo", [`q${i}`]).then(() => "ok", () => "dropped"));
    await vi.advanceTimersByTimeAsync(10);
    expect((await Promise.all(ps.slice(0, 5))).every((r) => r === "dropped")).toBe(true);
  });

  it("aborts a batch fetch that never answers", async () => {
    globalThis.fetch = vi.fn((_u: string, init: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const rpc = createBatchRpc({
      endpoint: ENDPOINT, batchWindowMs: 10, maxServerErrorRetries: 0, requestTimeoutMs: 500,
    });
    const p = rpc.enqueue("getAccountInfo", ["slow"]).then(() => "ok", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(700);
    expect(await p).toBe("aborted");
  });

  it("invalidateInflightDedupe: a read after a tx does not join a request already on the wire", async () => {
    const resolvers: Array<(r: unknown) => void> = [];
    globalThis.fetch = vi.fn((_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Body;
      return new Promise((res) => resolvers.push(() => res({
        ok: true, status: 200, headers: new Headers(),
        json: async () => body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: { n: resolvers.length } })),
      })));
    }) as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 10 });

    const before = rpc.enqueue("getAccountInfo", ["acct"]);
    await vi.advanceTimersByTimeAsync(20); // request 1 is now in flight
    // Without invalidation an identical read joins the in-flight request.
    const joined = rpc.enqueue("getAccountInfo", ["acct"]);
    expect(joined).toBe(before);

    rpc.invalidateInflightDedupe(); // tx confirmed
    const after = rpc.enqueue("getAccountInfo", ["acct"]);
    expect(after).not.toBe(before);
    await vi.advanceTimersByTimeAsync(20);
    expect(resolvers).toHaveLength(2); // a separate request was sent
    resolvers.forEach((r) => r(null));
    await Promise.all([before, after]);
  });
});
