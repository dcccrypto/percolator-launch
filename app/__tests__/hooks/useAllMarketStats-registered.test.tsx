/**
 * percolator-indexer#223: when a registration lands on this device the markets lists refetch past the
 * CDN copy (distinct URL, no-store) instead of waiting for the next 30 s poll + the CDN's stale window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";
import { statsMapsEqual, useAllMarketStats } from "@/hooks/useAllMarketStats";
import { announceMarketRegistered } from "@/lib/keeper-register-client";

const SLAB_OLD = "11111111111111111111111111111112";
const SLAB_NEW = "11111111111111111111111111111113";

function mockFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const markets = u.includes("fresh=") ? [{ slab_address: SLAB_OLD }, { slab_address: SLAB_NEW }] : [{ slab_address: SLAB_OLD }];
    return { ok: true, status: 200, json: async () => ({ markets }) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}
// A fresh cache per test; the provider function must be stable across the wrapper's re-renders.
let cache = new Map();
const provider = () => cache;
const config = { provider, dedupingInterval: 0 };
const wrapper = ({ children }: { children: React.ReactNode }) => <SWRConfig value={config}>{children}</SWRConfig>;

afterEach(() => {
  cleanup();
  cache = new Map();
});

describe("useAllMarketStats refetches fresh when a registration lands", () => {
  it("event -> one extra no-store fetch on a distinct URL; the new market appears", async () => {
    const calls = mockFetch();
    const { result } = renderHook(() => useAllMarketStats(), { wrapper });
    await waitFor(() => expect(result.current.statsMap.size).toBe(1));
    expect(calls.every((c) => !c.url.includes("fresh="))).toBe(true);

    await act(async () => { announceMarketRegistered(SLAB_NEW); });
    await waitFor(() => expect(result.current.statsMap.has(SLAB_NEW)).toBe(true));
    const fresh = calls.filter((c) => c.url.includes("fresh="));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].init?.cache).toBe("no-store");
  });

  it("CONTROL: no event, no fresh fetch, the new market is not in the list", async () => {
    const calls = mockFetch();
    const { result } = renderHook(() => useAllMarketStats(), { wrapper });
    await waitFor(() => expect(result.current.statsMap.size).toBe(1));
    expect(calls.filter((c) => c.url.includes("fresh="))).toHaveLength(0);
    expect(result.current.statsMap.has(SLAB_NEW)).toBe(false);
  });
});

describe("SWR must see a changed markets Map as changed", () => {
  const row = (slab: string, extra: object = {}) => ({ slab_address: slab, ...extra }) as never;
  it("different sizes / different values are not equal; identical content is", () => {
    const a = new Map([[SLAB_OLD, row(SLAB_OLD)]]);
    expect(statsMapsEqual(a, new Map([[SLAB_OLD, row(SLAB_OLD)]]))).toBe(true);
    expect(statsMapsEqual(a, new Map([[SLAB_OLD, row(SLAB_OLD)], [SLAB_NEW, row(SLAB_NEW)]]))).toBe(false);
    expect(statsMapsEqual(a, new Map([[SLAB_OLD, row(SLAB_OLD, { last_price: 2 })]]))).toBe(false);
    expect(statsMapsEqual(a, undefined)).toBe(false);
  });

  it("NEGATIVE CONTROL: SWR's own default compare (dequal/lite) calls two different Maps equal", async () => {
    const { compare } = await import("swr/_internal");
    const a = new Map([[SLAB_OLD, row(SLAB_OLD)]]);
    const b = new Map([[SLAB_OLD, row(SLAB_OLD)], [SLAB_NEW, row(SLAB_NEW)]]);
    expect(compare(a, b)).toBe(true); // the bug: a changed list looked unchanged
    expect(statsMapsEqual(a, b)).toBe(false);
  });
});
