// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => ({ list: mocks.list, put: mocks.put }));

import { ADL_SINCE_BLOB_PATHNAME, __resetAdlSinceStore, recordAdlObservations } from "@/lib/adl-since-store";

const T0 = Date.UTC(2026, 9, 3, 15, 18, 0);
function blobHolds(map: Record<string, number> | null) {
  mocks.list.mockResolvedValue({ blobs: map === null ? [] : [{ pathname: ADL_SINCE_BLOB_PATHNAME, url: "https://blob.test/adl-since.json" }] });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => map })));
}

describe("recordAdlObservations (durable first-seen store)", () => {
  beforeEach(() => {
    __resetAdlSinceStore();
    mocks.list.mockReset();
    mocks.put.mockReset();
    mocks.put.mockResolvedValue({});
  });

  it("an episode that starts is written once, with the start time", async () => {
    blobHolds({});
    const out = await recordAdlObservations([{ slab: "A", reduceOnly: true }], T0);
    expect(out).toEqual({ A: T0 });
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][0]).toBe(ADL_SINCE_BLOB_PATHNAME);
    expect(JSON.parse(mocks.put.mock.calls[0][1] as string)).toEqual({ A: T0 });
  });

  it("survives a cold start: the stored start is returned and nothing is rewritten", async () => {
    blobHolds({ A: T0 });
    const out = await recordAdlObservations([{ slab: "A", reduceOnly: true }], T0 + 5 * 3_600_000);
    expect(out).toEqual({ A: T0 });
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("an episode that ends is removed from the store", async () => {
    blobHolds({ A: T0 });
    const out = await recordAdlObservations([{ slab: "A", reduceOnly: false }], T0 + 1000);
    expect(out).toEqual({});
    expect(JSON.parse(mocks.put.mock.calls[0][1] as string)).toEqual({});
  });

  it("an unreadable blob never throws and never writes over what it could not read", async () => {
    mocks.list.mockRejectedValue(new Error("blob down"));
    const out = await recordAdlObservations([{ slab: "Z", reduceOnly: true }], T0);
    expect(out.Z).toBe(T0);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("a failed write is swallowed (health must never depend on the store)", async () => {
    blobHolds({});
    mocks.put.mockRejectedValue(new Error("quota"));
    await expect(recordAdlObservations([{ slab: "B", reduceOnly: true }], T0)).resolves.toEqual({ B: T0 });
  });

  it("nothing close-only and nothing stored a moment ago: the Blob is not read again", async () => {
    blobHolds({});
    await recordAdlObservations([{ slab: "A", reduceOnly: false }], T0); // reads once, learns the store is empty
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await recordAdlObservations([{ slab: "A", reduceOnly: false }], T0 + 1_000);
    await recordAdlObservations([{ slab: "B", reduceOnly: null }], T0 + 2_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    // NEGATIVE CONTROL: a close-only market always reads (and a stored entry for an ended episode is cleared)
    await recordAdlObservations([{ slab: "A", reduceOnly: true }], T0 + 3_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("a stored entry for a slab that is no longer close-only is NOT skipped past", async () => {
    blobHolds({ A: T0 });
    await recordAdlObservations([{ slab: "Z", reduceOnly: false }], T0); // learns {A: T0}
    const out = await recordAdlObservations([{ slab: "A", reduceOnly: false }], T0 + 1_000);
    expect(out).toEqual({});
    expect(mocks.put).toHaveBeenCalled();
  });

  it("a hung Blob times out instead of stalling the caller", async () => {
    vi.useFakeTimers();
    mocks.list.mockReturnValue(new Promise(() => undefined));
    const p = recordAdlObservations([{ slab: "A", reduceOnly: true }], T0);
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(p).resolves.toEqual({ A: T0 });
    vi.useRealTimers();
  });
});
