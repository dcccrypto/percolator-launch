// @vitest-environment node
/** lib/swr-memo.ts: per-key stale-while-revalidate memo used by the no-Supabase /api/markets/[slab] path. */
import { describe, expect, it, vi } from "vitest";
import { createSwrMemo } from "@/lib/swr-memo";

function setup(over: Partial<Parameters<typeof createSwrMemo<string, number>>[0]> = {}) {
  let t = 1_000_000;
  const memo = createSwrMemo<string, number>({ freshMs: 5_000, staleMs: 20_000, max: 3, shouldStore: (v) => v >= 0, now: () => t, ...over });
  return { memo, at: (ms: number) => { t = 1_000_000 + ms; } };
}

describe("createSwrMemo", () => {
  it("fresh window: one load per key, served from memory", async () => {
    const { memo, at } = setup();
    const load = vi.fn(async () => 1);
    expect(await memo.get("a", load)).toBe(1);
    at(4_999);
    expect(await memo.get("a", load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers share one load", async () => {
    const { memo } = setup();
    const load = vi.fn(async () => 1);
    await Promise.all([memo.get("a", load), memo.get("a", load), memo.get("a", load)]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keys are independent", async () => {
    const { memo } = setup();
    expect(await memo.get("a", async () => 1)).toBe(1);
    expect(await memo.get("b", async () => 2)).toBe(2);
  });

  it("stale window: old value returned at once, one background refresh replaces it", async () => {
    const { memo, at } = setup();
    await memo.get("a", async () => 1);
    at(5_000);
    let release!: (v: number) => void;
    const slow = vi.fn(() => new Promise<number>((r) => { release = r; }));
    expect(await memo.get("a", slow)).toBe(1);
    expect(await memo.get("a", slow)).toBe(1);
    expect(slow).toHaveBeenCalledTimes(1);
    release(2);
    await vi.waitFor(async () => expect(await memo.get("a", async () => 99)).toBe(2));
  });

  it("past fresh + stale: the caller waits for a new load", async () => {
    const { memo, at } = setup();
    await memo.get("a", async () => 1);
    at(25_000);
    expect(await memo.get("a", async () => 2)).toBe(2);
  });

  it("values failing shouldStore are returned but never stored", async () => {
    const { memo } = setup();
    const load = vi.fn(async () => -1);
    expect(await memo.get("a", load)).toBe(-1);
    expect(await memo.get("a", load)).toBe(-1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a failed load rejects for its caller and is not stored; a failed background refresh keeps the old value", async () => {
    const { memo, at } = setup();
    await expect(memo.get("a", async () => { throw new Error("rpc"); })).rejects.toThrow("rpc");
    expect(await memo.get("a", async () => 1)).toBe(1);
    at(6_000);
    expect(await memo.get("a", async () => { throw new Error("rpc"); })).toBe(1);
    await Promise.resolve();
    expect(await memo.get("a", async () => 7)).toBe(1); // the failed refresh left the stale value; this starts another refresh
  });

  it("bounded: the oldest-stored key is evicted past max", async () => {
    const { memo } = setup();
    for (const k of ["a", "b", "c", "d"]) await memo.get(k, async () => 1);
    const load = vi.fn(async () => 5);
    expect(await memo.get("a", load)).toBe(5); // evicted -> reloaded
    expect(await memo.get("d", load)).toBe(1); // still stored
  });

  it("ttlCapMs 0 turns it off; clear() forgets everything", async () => {
    let cap = 0;
    const { memo } = setup({ ttlCapMs: () => cap });
    const load = vi.fn(async () => 1);
    await memo.get("a", load);
    await memo.get("a", load);
    expect(load).toHaveBeenCalledTimes(2);
    cap = Infinity;
    await memo.get("a", load);
    memo.clear();
    await memo.get("a", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
