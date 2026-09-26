/**
 * Timing tests for /my-markets' per-market detail resolution.
 *
 * These exist because the behaviour that broke is INVISIBLE to a source-level
 * assertion. The original defect was one `Promise.all(...).then(setDetails)`,
 * and a regex pin forbidding that spelling passes against implementations that
 * are identical or worse — `Promise.allSettled(...)`, or awaiting each market
 * in sequence (which makes total latency the SUM of per-market latencies,
 * ~3.25s for the five measured, versus 1022ms for the batch it replaced).
 *
 * Driving the hook with one controlled promise per slab is the only way to
 * assert the property that actually matters: a row resolves on its own fetch,
 * not on its siblings'.
 *
 * Deferred/renderHook idiom follows __tests__/hooks/useTokenMeta.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useCreatorMarketDetails } from "../../hooks/useCreatorMarketDetails";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const SLAB_A = "slabAAA";
const SLAB_B = "slabBBB";
const SLAB_C = "slabCCC";

/** One controlled response per slab, plus a record of which were requested —
 *  the request LOG is what catches a sequential implementation, because it
 *  never issues the second request until the first settles. */
let pending: Record<string, Deferred<Response>>;
let requested: string[];

function marketResponse(slab: string, symbol: string): Response {
  return {
    ok: true,
    json: async () => ({ market: { slab_address: slab, symbol, vault_balance: 1_000_000 } }),
  } as unknown as Response;
}

beforeEach(() => {
  requested = [];
  pending = {
    [SLAB_A]: deferred<Response>(),
    [SLAB_B]: deferred<Response>(),
    [SLAB_C]: deferred<Response>(),
  };
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const slab = String(url).split("/").pop() as string;
    requested.push(slab);
    const d = pending[slab];
    if (!d) throw new Error(`Unexpected slab ${slab}`);
    return d.promise;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a market resolves on its own fetch, not its siblings'", () => {
  it("publishes B while A is still in flight", async () => {
    // THE BUG: with one batched publish, B's row stayed blank until A settled.
    // Measured on the live playground, four markets were ready in 517-635ms and
    // were held back ~400-500ms by one that took 1022ms.
    const { result } = renderHook(() => useCreatorMarketDetails([SLAB_A, SLAB_B]));

    // Both requests must already be OUT. A sequential implementation has only
    // issued A at this point, so this is what kills that mutant.
    await waitFor(() => expect(requested).toHaveLength(2));
    expect(requested).toContain(SLAB_A);
    expect(requested).toContain(SLAB_B);

    pending[SLAB_B].resolve(marketResponse(SLAB_B, "SOLCAT"));

    await waitFor(() => expect(result.current.details[SLAB_B]?.symbol).toBe("SOLCAT"));
    // And A is still genuinely outstanding — so B did not arrive because
    // everything arrived.
    expect(result.current.details[SLAB_A]).toBeUndefined();
    expect(result.current.detailsLoading).toBe(true);
  });

  it("CONTROL: A still lands once it does answer, and does not evict B", async () => {
    // Guards against "publish incrementally" degrading into a replace, where
    // each arrival wipes the previous one — strictly worse than the batch.
    const { result } = renderHook(() => useCreatorMarketDetails([SLAB_A, SLAB_B]));
    await waitFor(() => expect(requested).toHaveLength(2));

    pending[SLAB_B].resolve(marketResponse(SLAB_B, "SOLCAT"));
    await waitFor(() => expect(result.current.details[SLAB_B]).toBeTruthy());

    pending[SLAB_A].resolve(marketResponse(SLAB_A, "COLLECT"));
    await waitFor(() => expect(result.current.details[SLAB_A]?.symbol).toBe("COLLECT"));
    expect(result.current.details[SLAB_B]?.symbol).toBe("SOLCAT");
  });
});

describe("a permanently failing market must not strand the spinner", () => {
  it("clears loading once every fetch has settled, including a failure", async () => {
    // The page reads detailsLoading to decide whether to label its liquidity
    // total as still resolving. Without the settle counter it reads
    // "Resolving — 1 of 2 markets…" forever on a market that never answers.
    const { result } = renderHook(() => useCreatorMarketDetails([SLAB_A, SLAB_B]));
    await waitFor(() => expect(requested).toHaveLength(2));

    pending[SLAB_B].resolve(marketResponse(SLAB_B, "SOLCAT"));
    pending[SLAB_A].reject(new Error("500"));

    await waitFor(() => expect(result.current.detailsLoading).toBe(false));
    // The failure must not take the market that DID resolve down with it.
    expect(result.current.details[SLAB_B]?.symbol).toBe("SOLCAT");
    expect(result.current.details[SLAB_A]).toBeUndefined();
  });

  it("a non-ok response leaves an already-resolved row intact", async () => {
    const { result } = renderHook(() => useCreatorMarketDetails([SLAB_A, SLAB_B]));
    await waitFor(() => expect(requested).toHaveLength(2));

    pending[SLAB_A].resolve(marketResponse(SLAB_A, "COLLECT"));
    await waitFor(() => expect(result.current.details[SLAB_A]?.symbol).toBe("COLLECT"));

    pending[SLAB_B].resolve({ ok: false } as unknown as Response);
    await waitFor(() => expect(result.current.detailsLoading).toBe(false));
    expect(result.current.details[SLAB_A]?.symbol).toBe("COLLECT");
  });
});

describe("a previous wallet's response must not land in the current list", () => {
  it("drops a response that arrives after the slab list changed", async () => {
    // This is the real staleness guard, and it is the `cancelled` check — NOT
    // applyResolved's allow-list, which is tautologically true at this call
    // site because the slab is drawn from the same list that is passed as the
    // allow-list. Nothing else in the suite covers it.
    const { result, rerender } = renderHook(
      ({ slabs }) => useCreatorMarketDetails(slabs),
      { initialProps: { slabs: [SLAB_A] } },
    );
    await waitFor(() => expect(requested).toContain(SLAB_A));

    rerender({ slabs: [SLAB_C] });
    await waitFor(() => expect(requested).toContain(SLAB_C));

    // The abandoned request still completes — nothing aborts it.
    pending[SLAB_A].resolve(marketResponse(SLAB_A, "GHOST"));
    pending[SLAB_C].resolve(marketResponse(SLAB_C, "TEXTIT"));

    await waitFor(() => expect(result.current.details[SLAB_C]?.symbol).toBe("TEXTIT"));
    expect(result.current.details[SLAB_A]).toBeUndefined();
  });

  it("clears the flag when the creator's last market disappears", async () => {
    // The empty-list early return used to skip setLoading(false) entirely, so
    // a wallet going from N markets to 0 left the flag true for good.
    const { result, rerender } = renderHook(
      ({ slabs }) => useCreatorMarketDetails(slabs),
      { initialProps: { slabs: [SLAB_A] } },
    );
    await waitFor(() => expect(result.current.detailsLoading).toBe(true));

    rerender({ slabs: [] });
    await waitFor(() => expect(result.current.detailsLoading).toBe(false));
    expect(result.current.details).toEqual({});
  });
});
