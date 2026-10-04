// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => ({ list: mocks.list, put: mocks.put }));

import { ADL_SINCE_BLOB_PATHNAME, recordAdlObservations } from "@/lib/adl-since-store";

const T0 = Date.UTC(2026, 9, 3, 15, 18, 0);
function blobHolds(map: Record<string, number> | null) {
  mocks.list.mockResolvedValue({ blobs: map === null ? [] : [{ pathname: ADL_SINCE_BLOB_PATHNAME, url: "https://blob.test/adl-since.json" }] });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => map })));
}

describe("recordAdlObservations (durable first-seen store)", () => {
  beforeEach(() => {
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
});
