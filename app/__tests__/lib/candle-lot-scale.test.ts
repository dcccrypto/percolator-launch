// @vitest-environment node
/** lib/candle-lot-scale: lot_exp + per-token anchor for /api/candles; every failure means "no lots" (candles unchanged). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const read = vi.fn();
const lotExp = vi.fn();
const markE6 = vi.fn();
const flag = vi.fn();
vi.mock("@/lib/v22/flag", () => ({ isDevnetV22Enabled: () => flag() }));
vi.mock("@/lib/current-wrapper-slab", () => ({ readCurrentWrapperSlab: (s: string) => read(s) }));
vi.mock("@/lib/v22/lot", () => ({ lotExpOf: () => lotExp() }));
vi.mock("@percolatorct/sdk", () => ({
  V17_HEADER_LEN: 0,
  parseWrapperConfigV17: () => ({ markEwmaE6: markE6() }),
}));

const { readCandleLotScale, candleLotScaleOf, __clearCandleLotScaleCache } = await import("@/lib/candle-lot-scale");
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const BYTES = new Uint8Array(8);

beforeEach(() => {
  __clearCandleLotScaleCache();
  flag.mockReset().mockReturnValue(true);
  read.mockReset().mockResolvedValue({ ok: true, data: BYTES });
  lotExp.mockReset().mockReturnValue(3);
  markE6.mockReset().mockReturnValue(53_000_000n); // $53 per lot of 1000 tokens
});

describe("candle lot scale", () => {
  it("lot market: lot_exp and the per-token mark as anchor", async () => {
    expect(await readCandleLotScale(SLAB)).toEqual({ lotExp: 3, anchor: 0.053 });
  });
  it("lot_exp 0, a zero / absurd mark, or a parse error: no lots", () => {
    lotExp.mockReturnValue(0);
    expect(candleLotScaleOf(BYTES)).toEqual({ lotExp: 0, anchor: null });
    lotExp.mockReturnValue(3);
    markE6.mockReturnValue(0n);
    expect(candleLotScaleOf(BYTES)).toEqual({ lotExp: 0, anchor: null });
    markE6.mockReturnValue(10n ** 13n);
    expect(candleLotScaleOf(BYTES)).toEqual({ lotExp: 0, anchor: null });
    markE6.mockImplementation(() => { throw new Error("bad layout"); });
    expect(candleLotScaleOf(BYTES)).toEqual({ lotExp: 0, anchor: null });
  });
  it("RPC failure or a throwing read: no lots, marked unknown and not cached", async () => {
    read.mockResolvedValueOnce({ ok: false, reason: "rpc" });
    expect(await readCandleLotScale(SLAB, 1)).toEqual({ lotExp: 0, anchor: null, unknown: true });
    read.mockRejectedValueOnce(new Error("boom"));
    expect(await readCandleLotScale(SLAB, 2)).toEqual({ lotExp: 0, anchor: null, unknown: true });
    expect(await readCandleLotScale(SLAB, 3)).toEqual({ lotExp: 3, anchor: 0.053 }); // retried, not served from cache
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("not a current-wrapper market: no lots (known, cached)", async () => {
    read.mockResolvedValue({ ok: false, reason: "not-found" });
    expect(await readCandleLotScale(SLAB, 1)).toEqual({ lotExp: 0, anchor: null });
  });
  it("v2.2 flag off: no lots and no RPC read", async () => {
    flag.mockReturnValue(false);
    expect(await readCandleLotScale(SLAB, 1)).toEqual({ lotExp: 0, anchor: null });
    expect(read).not.toHaveBeenCalled();
  });
  it("the route does not edge-cache a window as history when the lot scale is unknown", () => {
    const route = fs.readFileSync(path.resolve(__dirname, "../../app/api/candles/[slab]/route.ts"), "utf8");
    expect(route).toMatch(/const closed = win\.endExclusive \+ CLOSED_MARGIN_SEC <= nowSec && !lot\.unknown;/);
  });
  it("cached for a minute per slab", async () => {
    await readCandleLotScale(SLAB, 1_000);
    await readCandleLotScale(SLAB, 60_999);
    expect(read).toHaveBeenCalledTimes(1);
    await readCandleLotScale(SLAB, 61_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
