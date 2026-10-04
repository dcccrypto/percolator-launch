import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  ua: null as unknown,
  liq: null as bigint | null,
  slab: { config: null as unknown, params: null as unknown, adlFactors: null as unknown, wrapperConfigV17: null as unknown },
  pnl: null as unknown,
  calls: [] as unknown[],
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => m.ua }));
vi.mock("@/hooks/useLiqPrice", () => ({ useLiqPrice: () => m.liq }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => m.slab }));
vi.mock("@/lib/position-pnl", () => ({ terminalPositionPnl: (a: unknown) => { m.calls.push(a); return m.pnl; } }));

import { usePositionLinePrices } from "@/hooks/usePositionLinePrices";

const owner = { toBase58: () => "OWNER" };
const ua = (size = 1_000_000n) => ({ idx: 1, account: { positionSize: size, pnl: 0n, capital: 1n, owner } });
const pnl = (o: Record<string, unknown>) => ({ pnlKnown: true, entry: 3_400n, entrySource: "cache", isEstimate: false, ...o });

beforeEach(() => {
  m.ua = ua(); m.liq = 2_100n; m.pnl = pnl({}); m.calls = [];
  m.slab = { config: { lastEffectivePriceE6: 3_600n, invert: 0 }, params: { initialMarginBps: 1000n }, adlFactors: { f: 1 }, wrapperConfigV17: {} };
});
const run = () => renderHook(() => usePositionLinePrices("S")).result.current;

describe("usePositionLinePrices (consumes computePositionPnl via terminalPositionPnl)", () => {
  it("draws entry and liq from the shared resolution, with ADL inputs passed through", () => {
    expect(run()).toEqual({ entry: 0.0034, liq: 0.0021, entryIsEstimate: false });
    expect(m.calls[0]).toMatchObject({ slabAddress: "S", accountIdx: 1, adlApplicable: true, markE6: 3_600n });
  });
  it("marks a back-solved entry as an estimate", () => {
    m.pnl = pnl({ entrySource: "derived", isEstimate: true });
    expect(run().entryIsEstimate).toBe(true);
  });
  it("a server entry is exact (not an estimate)", () => {
    m.pnl = pnl({ entrySource: "server" });
    expect(run()).toMatchObject({ entry: 0.0034, entryIsEstimate: false });
  });
  it("NEGATIVE CONTROL: pnlKnown=false draws NO entry and NO liq line, even if both numbers exist", () => {
    m.pnl = pnl({ pnlKnown: false });
    expect(run()).toEqual({ entry: null, liq: null, entryIsEstimate: false });
  });
  it("NEGATIVE CONTROL: unknown entry source draws nothing (never the mark fallback)", () => {
    m.pnl = pnl({ entrySource: "unknown", entry: 3_600n });
    expect(run().entry).toBeNull();
  });
  it("no position: nothing; legacy engine (no v17 config) passes adlApplicable=false", () => {
    m.ua = null;
    expect(run()).toEqual({ entry: null, liq: null, entryIsEstimate: false });
    m.ua = ua(0n);
    expect(run().entry).toBeNull();
    m.ua = ua(); m.slab.wrapperConfigV17 = null;
    run();
    expect(m.calls.at(-1)).toMatchObject({ adlApplicable: false });
  });
  it("liq only for a positive price", () => {
    m.liq = 0n;
    expect(run().liq).toBeNull();
    m.liq = null;
    expect(run().liq).toBeNull();
  });
});
