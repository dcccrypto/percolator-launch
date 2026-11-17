// Retry-After handling on 429: NaN (HTTP-date / empty / junk) must not become an instant retry,
// huge values must be clamped, and the 429 retry cap / queue-full behaviour must hold.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBatchRpc } from "@/lib/batchRpc";

const ENDPOINT = "http://localhost/api/rpc";

function r429(retryAfter?: string) {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("Retry-After", retryAfter);
  return { ok: false, status: 429, json: async () => ({}), headers };
}

describe("batchRpc Retry-After", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  /** Always-429 server; returns fetch call count after 1 s of fake time. */
  async function callsWithin1s(header: string | undefined, cfg = {}) {
    const f = vi.fn(async () => r429(header));
    globalThis.fetch = f as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, batchWindowMs: 50, initialBackoffMs: 1000, ...cfg });
    rpc.enqueue("getAccountInfo", ["a"]).catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    return f.mock.calls.length;
  }

  it("HTTP-date Retry-After is honoured (no tight loop)", async () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    expect(await callsWithin1s(date)).toBeLessThanOrEqual(2);
  });
  it("empty / junk Retry-After falls back to backoff (no tight loop)", async () => {
    expect(await callsWithin1s("soon")).toBeLessThanOrEqual(2);
  });
  it("negative Retry-After falls back to backoff", async () => {
    expect(await callsWithin1s("-5")).toBeLessThanOrEqual(2);
  });
  it("huge Retry-After is clamped to maxBackoffMs", async () => {
    const f = vi.fn(async () => r429("86400"));
    globalThis.fetch = f as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, maxBackoffMs: 5000, maxRetries: 1 });
    const p = rpc.enqueue("getAccountInfo", ["a"]);
    await vi.advanceTimersByTimeAsync(50 + 4000);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000 * 0.3 + 1100);
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await p).error.code).toBe(-32005);
  });
  it("delta-seconds Retry-After still works", async () => {
    const f = vi.fn(async () => r429("2"));
    globalThis.fetch = f as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, initialBackoffMs: 100, maxRetries: 1 });
    rpc.enqueue("getAccountInfo", ["a"]).catch(() => {});
    await vi.advanceTimersByTimeAsync(50 + 1900);
    expect(f).toHaveBeenCalledTimes(1); // 2 s honoured, not the 100 ms backoff
    await vi.advanceTimersByTimeAsync(1500);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("lead 2: 429 burst never exceeds maxRetries+1 fetches", async () => {
    const f = vi.fn(async () => r429("0"));
    globalThis.fetch = f as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, maxRetries: 3 });
    const p = rpc.enqueue("getAccountInfo", ["a"]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f).toHaveBeenCalledTimes(4);
    expect(JSON.parse(await p).error.code).toBe(-32005);
  });

  it("lead 3: full queue rejects the oldest callers instead of hanging", async () => {
    globalThis.fetch = vi.fn(async () => r429("1")) as unknown as typeof fetch;
    const rpc = createBatchRpc({ endpoint: ENDPOINT, maxQueueSize: 3, maxBatchSize: 1000 });
    const ps = Array.from({ length: 5 }, (_, i) => rpc.enqueue("getAccountInfo", [i]).then(() => "ok", (e: Error) => e.message));
    await vi.advanceTimersByTimeAsync(0);
    expect(await ps[0]).toMatch(/queue full/);
    expect(await ps[1]).toMatch(/queue full/);
  });
});
