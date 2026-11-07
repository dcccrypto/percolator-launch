/**
 * Council 2026-11-07 council-leftovers run 2, finding 1 (Clerk, First-timer, Trader): the chart marker, the chart price
 * and the header LIVE badge disagreed, and with the feed dead the header never went stale. They now share one clock
 * (lib/price-freshness.ts). These tests pin WHAT advances it: a live price-WS message, an on-chain poll that moved the
 * price, a chart tick. And what must NOT: 24h stats, seeds (those made a dead feed flip Live/Delayed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
const ws = vi.hoisted(() => ({ handler: null as null | ((d: unknown) => void) }));

vi.mock("@/lib/priceStore/wsManager", () => ({
  getWsManager: () => ({
    subscribeChannel: () => () => {},
    onMessageForChannel: (_c: string, l: (d: unknown) => void) => {
      ws.handler = l;
      return () => { ws.handler = null; };
    },
    onStatusChange: () => () => {},
    getStatus: () => "open",
  }),
}));
vi.mock("@/lib/price-ws-url", () => ({ getPriceWsUrl: () => "wss://feed.test" }));
vi.mock("@/lib/v22/lot-registry", () => ({ ensureLotExp: () => {}, getLotExp: () => 0, onLotExp: () => () => {} }));

import { __resetPriceFreshnessForTests, getPriceFreshAt, markPriceFresh, priceFreshness } from "@/lib/price-freshness";
import { applyOnChainPoll, seedFromDbIfEmpty, seedFromOnChain, setStats24h, subscribeSlab } from "@/lib/priceStore/priceStore";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
  __resetPriceFreshnessForTests();
});
afterEach(() => vi.useRealTimers());

describe("price freshness: one clock, live → delayed → offline", () => {
  it("never fresh reads offline; a fresh price reads live, then delayed after 10 s, offline after 60 s", () => {
    expect(priceFreshness(SLAB).state).toBe("offline");
    markPriceFresh(SLAB);
    expect(priceFreshness(SLAB).state).toBe("live");
    vi.advanceTimersByTime(10_001);
    expect(priceFreshness(SLAB).state).toBe("delayed");
    vi.advanceTimersByTime(50_000);
    expect(priceFreshness(SLAB).state).toBe("offline");
  });

  it("never moves backwards", () => {
    markPriceFresh(SLAB, 2_000);
    markPriceFresh(SLAB, 1_000);
    expect(getPriceFreshAt(SLAB)).toBe(2_000);
  });
});

describe("price store: what counts as a fresh price", () => {
  it("a live price-WS message for the slab advances the clock (on receipt)", () => {
    const off = subscribeSlab(SLAB, () => {});
    expect(ws.handler).not.toBeNull();
    ws.handler!({ type: "price", slab: SLAB, price: 150.25 });
    expect(getPriceFreshAt(SLAB)).toBe(Date.now());
    off();
  });

  it("a message for another slab or a malformed price does not", () => {
    const off = subscribeSlab(SLAB, () => {});
    ws.handler!({ type: "price", slab: "other", price: 150 });
    ws.handler!({ type: "price", slab: SLAB, price: -1 });
    ws.handler!({ type: "tick", slab: SLAB });
    expect(getPriceFreshAt(SLAB)).toBeNull();
    off();
  });

  it("24h stats and seeds do NOT count as a fresh price (a dead feed used to flip Live/Delayed on them)", () => {
    const other = "SeedSlab1111111111111111111111111111111111";
    seedFromDbIfEmpty(other, 1.5, undefined);
    seedFromOnChain(other, 1_500_000n);
    setStats24h(other, { change24h: 1, high24h: 2, low24h: 1 });
    expect(getPriceFreshAt(other)).toBeNull();
  });

  it("an on-chain poll counts only when it moved the price (an unchanged stalled mark is not fresh)", () => {
    const s = "PollSlab1111111111111111111111111111111111";
    expect(applyOnChainPoll(s, 2_000_000n)).toBe(true);
    const first = getPriceFreshAt(s);
    expect(first).toBe(Date.now());
    vi.advanceTimersByTime(30_000);
    expect(applyOnChainPoll(s, 2_000_000n)).toBe(false);
    expect(getPriceFreshAt(s)).toBe(first);
    expect(priceFreshness(s).state).toBe("delayed");
    expect(applyOnChainPoll(s, 2_100_000n)).toBe(true);
    expect(priceFreshness(s).state).toBe("live");
  });
});
