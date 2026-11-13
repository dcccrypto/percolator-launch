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
    const failing = vi.fn(async () => { throw new Error("rpc"); });
    expect(await memo.get("a", failing)).toBe(1);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // let the rejected refresh settle
    const next = vi.fn(async () => 7);
    expect(await memo.get("a", next)).toBe(1); // still the old value...
    expect(next).toHaveBeenCalledTimes(1); // ...and a NEW refresh started (the failed one is not still registered)
  });

  it("a loader that throws synchronously is a rejection, and stale callers still get the old value", async () => {
    const { memo, at } = setup();
    const sync = (() => { throw new Error("sync"); }) as unknown as () => Promise<number>;
    await expect(memo.get("a", sync)).rejects.toThrow("sync");
    await memo.get("a", async () => 1);
    at(6_000);
    expect(await memo.get("a", sync)).toBe(1);
  });

  it("clear() during an in-flight load: that load does not repopulate", async () => {
    const { memo } = setup();
    let release!: (v: number) => void;
    const p = memo.get("a", () => new Promise<number>((r) => { release = r; }));
    await vi.waitFor(() => expect(release).toBeDefined()); // the loader starts on a microtask
    memo.clear();
    release(1);
    expect(await p).toBe(1);
    const load = vi.fn(async () => 2);
    expect(await memo.get("a", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a slow older load does not overwrite a newer stored value", async () => {
    const { memo, at } = setup();
    let releaseOld!: (v: number) => void;
    const old = memo.get("a", () => new Promise<number>((r) => { releaseOld = r; })); // started at t=0
    await vi.waitFor(() => expect(releaseOld).toBeDefined());
    at(5_000); // past the fresh window: the in-flight load is no longer shared
    expect(await memo.get("a", async () => 2)).toBe(2); // newer load, stored at t=5000
    releaseOld(1);
    await old;
    expect(await memo.get("a", async () => 99)).toBe(2);
  });

  it("each background refresh is handed to onBackground; a throwing onBackground is ignored", async () => {
    const seen: Promise<unknown>[] = [];
    const { memo, at } = setup({ onBackground: (p) => { seen.push(p); throw new Error("no request scope"); } });
    await memo.get("a", async () => 1);
    at(6_000);
    expect(await memo.get("a", async () => 2)).toBe(1);
    expect(seen).toHaveLength(1);
    await seen[0];
    expect(await memo.get("a", async () => 3)).toBe(2);
  });

  it("a cap below freshMs also drops the stale window", async () => {
    const { memo, at } = setup({ ttlCapMs: () => 1_000 });
    await memo.get("a", async () => 1);
    at(1_000);
    expect(await memo.get("a", async () => 2)).toBe(2);
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
