import { describe, expect, it, vi } from "vitest";

// #2320 — `entries` was only ever written, never pruned. WebSocket resources were
// already released on last-unsubscribe, so this was never a socket leak, but the
// deliberately-retained snapshots grew without bound over a long browsing session.
//
// Driven entirely through the public API: seedFromOnChain() creates an entry, and
// getSnapshot() reports whether one is still cached.
describe("#2320 priceStore caps retained snapshots", () => {
  it("evicts idle entries past the cap, and keeps a subscribed one alive", async () => {
    vi.resetModules();
    const store = await import("../../lib/priceStore/priceStore");

    // A subscribed slab must survive eviction no matter how much churn follows.
    const pinned = "PINNED_SLAB";
    const unsub = store.subscribeSlab(pinned, () => {});
    store.seedFromOnChain(pinned, 1_000_000n);
    expect(store.getSnapshot(pinned)).not.toBe(store.EMPTY_PRICE_STATE);

    // Churn well past the 64 cap with idle slabs.
    for (let i = 0; i < 300; i++) store.seedFromOnChain(`IDLE_${i}`, BigInt(i + 1));

    // The pinned, subscribed entry is still cached...
    expect(store.getSnapshot(pinned)).not.toBe(store.EMPTY_PRICE_STATE);
    // ...while the earliest idle ones have been evicted (unbounded growth would
    // have kept every one of them).
    const earliestGone = store.getSnapshot("IDLE_0") === store.EMPTY_PRICE_STATE;
    expect(earliestGone).toBe(true);

    unsub();
  });
});
