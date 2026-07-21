/**
 * applyOnChainPoll (PositionsBar's recurring on-chain freshness floor):
 * the poll may only ever REPLACE data staler than itself — a slab with a
 * recent live WS tick must be untouchable, and a slab whose feed went
 * quiet must become updatable again after LIVE_TICK_STALE_MS.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Capture the WS message listeners so tests can inject "live" ticks without a
// real socket. priceStore subscribes via `onMessageForChannel(slab, listener)`,
// which dispatches ONLY to listeners registered for that channel — so the mock
// keys listeners by channel rather than holding one global list. A global list
// would deliver every tick to every slab, which the real manager never does.
const channelListeners = new Map<string, Array<(data: unknown) => void>>();
vi.mock("@/lib/priceStore/wsManager", () => ({
  getWsManager: () => ({
    subscribeChannel: () => () => {},
    onMessage: () => () => {},
    onMessageForChannel: (channel: string, l: (data: unknown) => void) => {
      const list = channelListeners.get(channel) ?? [];
      list.push(l);
      channelListeners.set(channel, list);
      return () => {
        const cur = channelListeners.get(channel);
        if (cur) channelListeners.set(channel, cur.filter((x) => x !== l));
      };
    },
    onStatusChange: () => () => {},
  }),
}));

import {
  subscribeSlab,
  getSnapshot,
  applyOnChainPoll,
  seedFromDbIfEmpty,
} from "@/lib/priceStore/priceStore";

/** Deliver a live WS tick and force the store's buffered flush (the
 *  visibilitychange handler flushes pending ticks synchronously — same
 *  path the real store uses when a backgrounded tab returns). */
function deliverLiveTick(slab: string, price: number) {
  for (const l of channelListeners.get(slab) ?? []) l({ type: "price", slab, price });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyOnChainPoll", () => {
  it("seeds an empty slab", () => {
    applyOnChainPoll("poll-slab-empty", 5_000_000n);
    const snap = getSnapshot("poll-slab-empty");
    expect(snap.priceE6).toBe(5_000_000n);
    expect(snap.loading).toBe(false);
  });

  it("ignores non-positive prices", () => {
    applyOnChainPoll("poll-slab-zero", 0n);
    expect(getSnapshot("poll-slab-zero").priceE6).toBe(null);
  });

  it("overwrites a DB seed (poll data is fresher than a cold-start seed)", () => {
    seedFromDbIfEmpty("poll-slab-db", 1.5, undefined);
    expect(getSnapshot("poll-slab-db").priceE6).toBe(1_500_000n);
    applyOnChainPoll("poll-slab-db", 2_000_000n);
    expect(getSnapshot("poll-slab-db").priceE6).toBe(2_000_000n);
  });

  it("NEVER overwrites a recent live WS tick", () => {
    const slab = "poll-slab-live";
    const unsub = subscribeSlab(slab, () => {});
    deliverLiveTick(slab, 42);
    expect(getSnapshot(slab).priceE6).toBe(42_000_000n);

    applyOnChainPoll(slab, 999_000_000n);
    expect(getSnapshot(slab).priceE6).toBe(42_000_000n); // live wins
    unsub();
  });

  it("updates again once the live feed has been silent past the staleness window", () => {
    const slab = "poll-slab-stale-live";
    const unsub = subscribeSlab(slab, () => {});
    deliverLiveTick(slab, 42);
    expect(getSnapshot(slab).priceE6).toBe(42_000_000n);

    // 11s of feed silence (> LIVE_TICK_STALE_MS = 10s)
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 11_000);

    applyOnChainPoll(slab, 43_000_000n);
    expect(getSnapshot(slab).priceE6).toBe(43_000_000n); // poll allowed now
    unsub();
  });
});
