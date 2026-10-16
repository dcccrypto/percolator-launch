/**
 * Review N1: the lot exponent is a property of the MARKET. The price store may not ingest a per-TOKEN feed for a slab
 * whose exponent it does not know, whichever page subscribed; useTrade may not derive a limit from such a price.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<(data: unknown) => void> = [];
vi.mock("@/lib/priceStore/wsManager", () => ({
  getWsManager: () => ({
    subscribeChannel: () => () => {},
    onMessage: (l: (d: unknown) => void) => (listeners.push(l), () => {}),
    onMessageForChannel: (_c: string, l: (d: unknown) => void) => (listeners.push(l), () => {}),
    onStatusChange: () => () => {},
  }),
}));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __resetLotRegistryForTest, ensureLotExp, getLotExp, lotExpOfStrict, observeLotExp, setLotExpLoader, LOT_LOAD_RETRY_MS } from "@/lib/v22/lot-registry";
import { applyOnChainPoll, getLivePriceSnapshot, getSnapshot, isLotKnown, seedFromDbIfEmpty, subscribeSlab } from "@/lib/priceStore/priceStore";
import { LAYOUT_V22, LAYOUT_V21, WRAPPER_ACCOUNT_MAGIC, ACCOUNT_KIND } from "@/lib/v22/sdk";

function market(version: 19 | 18, lotExp: number): Uint8Array {
  const L = version === 19 ? LAYOUT_V22 : LAYOUT_V21;
  const d = new Uint8Array(L.marketGroupOff + L.marketGroupLen + L.assetSlotStride);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, L.version, true);
  d[10] = ACCOUNT_KIND.Market;
  d[L.marketGroupOff + L.marketGroupLen + L.wrapperSlot.profileLotExp] = lotExp;
  return d;
}
const tick = (slab: string, price: number) => {
  for (const l of listeners) l({ type: "price", slab, price });
  document.dispatchEvent(new Event("visibilitychange"));
};
let n = 0;
const fresh = () => `N1Slab${++n}${"x".repeat(30)}`;

beforeEach(() => {
  __resetLotRegistryForTest();
  __setDevnetV22ForTest(true);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("registry", () => {
  it("flag off: every market is known with exponent 0 and nothing is loaded", () => {
    __setDevnetV22ForTest(false);
    const load = vi.fn();
    setLotExpLoader(load);
    expect(getLotExp("anything")).toBe(0);
    ensureLotExp("anything");
    expect(load).not.toHaveBeenCalled();
  });
  it("flag on: unknown until slab bytes are observed; a v2.1 market is known as 0", () => {
    expect(getLotExp("s")).toBeNull();
    observeLotExp("s", market(19, 3));
    expect(getLotExp("s")).toBe(3);
    observeLotExp("t", market(18, 0));
    expect(getLotExp("t")).toBe(0);
    observeLotExp("u", new Uint8Array(10)); // unreadable: stays unknown
    expect(getLotExp("u")).toBeNull();
    expect(lotExpOfStrict(null)).toBeNull();
  });
  it("the loader is asked once per cooldown and its answer is recorded", async () => {
    let t = 0;
    __resetLotRegistryForTest(() => t);
    const load = vi.fn(async () => 2);
    setLotExpLoader(load);
    ensureLotExp("L");
    ensureLotExp("L");
    expect(load).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(getLotExp("L")).toBe(2);
    setLotExpLoader(vi.fn(async () => null));
    ensureLotExp("M");
    t += LOT_LOAD_RETRY_MS + 1;
    ensureLotExp("M");
  });
});

describe("price store: per-token feeds of a slab with an unknown exponent are NOT ingested (any page)", () => {
  it("a WS tick before the exponent is known is dropped; after it is known ticks are stored per lot", () => {
    const slab = fresh();
    const off = subscribeSlab(slab, () => {}); // e.g. the portfolio / positions bar, not the trade page
    tick(slab, 0.06);
    expect(getSnapshot(slab).priceE6).toBeNull(); // nothing stored: no per-token value posing as per-lot
    expect(isLotKnown(slab)).toBe(false);
    observeLotExp(slab, market(19, 3)); // ANY read of the slab bytes teaches the store
    expect(isLotKnown(slab)).toBe(true);
    // the dropped per-token tick left nothing behind: no 10^3-off value becomes visible the moment the exponent is known
    expect(getSnapshot(slab).priceE6).toBeNull();
    tick(slab, 0.06);
    expect(getSnapshot(slab).priceE6).toBe(60_000_000n);
    expect(getSnapshot(slab).lotExp).toBe(3);
    off();
  });
  it("a DB seed is held until the exponent is known, then applied per lot", () => {
    const slab = fresh();
    seedFromDbIfEmpty(slab, 0.06, undefined);
    expect(getSnapshot(slab).priceE6).toBeNull();
    observeLotExp(slab, market(19, 3));
    expect(getSnapshot(slab).priceE6).toBe(60_000_000n);
  });
  it("an on-chain poll (already per lot) is withheld from readers until known, then equals the on-chain value", () => {
    const slab = fresh();
    applyOnChainPoll(slab, 60_000_000n);
    expect(getLivePriceSnapshot(slab).priceE6).toBeNull(); // units unproven: withheld
    observeLotExp(slab, market(19, 3));
    expect(getLivePriceSnapshot(slab).priceE6).toBe(60_000_000n);
  });
  it("the exponent learned from a market read applies to every later subscriber of that slab (no page-level setter)", () => {
    const slab = fresh();
    observeLotExp(slab, market(19, 2));
    const off = subscribeSlab(slab, () => {});
    tick(slab, 1.5);
    expect(getSnapshot(slab).priceE6).toBe(150_000_000n);
    off();
  });
  it("flag off: identical to before (a tick is stored as is, always known)", () => {
    __setDevnetV22ForTest(false);
    const slab = fresh();
    const off = subscribeSlab(slab, () => {});
    tick(slab, 0.06);
    expect(getSnapshot(slab).priceE6).toBe(60_000n);
    expect(isLotKnown(slab)).toBe(true);
    off();
  });
});
