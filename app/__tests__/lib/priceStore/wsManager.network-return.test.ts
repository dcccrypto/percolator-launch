/**
 * N23: the shared price socket's circuit breaker stops retrying after MAX_RECONNECT_ATTEMPTS (~3 min
 * of backoff), and only a NEW subscriber reset it. A trade page left open gets none, so a Wi-Fi drop
 * or a price-ws redeploy longer than that left the chart "Offline" and the Mark frozen until a
 * reload. The network coming back, or the tab coming back into view, now revives it.
 * Real wsManager; only WebSocket is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const URL_ = "ws://live.test";
const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send() {}
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWs.all = [];
  vi.stubGlobal("WebSocket", FakeWs);
});
// vi.resetModules gives each test a fresh wsManager, but its online / visibility listeners would stay
// on the shared window and revive that test's managers into the next test's FakeWs.all: remove them.
const added: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
beforeEach(() => {
  for (const target of [window, document]) {
    const orig = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation((type, l, o) => {
      added.push([target, type, l as EventListenerOrEventListenerObject]);
      orig(type, l, o);
    });
  }
});
afterEach(() => {
  for (const [target, type, l] of added.splice(0)) target.removeEventListener(type, l);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Every socket fails as soon as it is created, until the breaker trips. */
async function tripBreaker() {
  const { getWsManager } = await import("@/lib/priceStore/wsManager");
  const h = getWsManager(URL_);
  h.subscribeChannel(SLAB);
  for (let i = 0; i < 40; i++) {
    const n = FakeWs.all.length;
    FakeWs.all[n - 1].close();
    vi.advanceTimersByTime(40_000); // past the longest backoff (30 s + 25% jitter)
    if (FakeWs.all.length === n) break; // no retry scheduled: tripped
  }
  return h;
}

describe("price socket after its reconnect breaker trips", () => {
  it("the breaker still stops after 10 retries; the network coming back opens a new socket", async () => {
    const h = await tripBreaker();
    const tripped = FakeWs.all.length;
    expect(tripped).toBe(11); // the first attempt + 10 retries
    vi.advanceTimersByTime(30 * 60_000);
    expect(FakeWs.all.length).toBe(tripped); // nothing more on its own
    expect(h.getStatus()).toBe("closed");

    window.dispatchEvent(new Event("online"));
    expect(FakeWs.all.length).toBe(tripped + 1);
    FakeWs.all[tripped].open();
    expect(h.getStatus()).toBe("open");
  });

  it("the tab becoming visible again also revives it", async () => {
    await tripBreaker();
    const tripped = FakeWs.all.length;
    document.dispatchEvent(new Event("visibilitychange")); // jsdom's visibilityState is "visible"
    expect(FakeWs.all.length).toBe(tripped + 1);
  });

  it("CONTROL: the tab being hidden does not revive it", async () => {
    await tripBreaker();
    const tripped = FakeWs.all.length;
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    vis.mockRestore();
    expect(FakeWs.all.length).toBe(tripped);
  });

  it("a revived socket gets the full retry budget again, not one attempt", async () => {
    await tripBreaker();
    const tripped = FakeWs.all.length;
    window.dispatchEvent(new Event("online"));
    FakeWs.all[tripped].close(); // still down
    vi.advanceTimersByTime(5_000);
    expect(FakeWs.all.length).toBe(tripped + 2); // retrying again
  });

  it("CONTROL: while a retry is already scheduled, coming online adds no extra socket", async () => {
    const { getWsManager } = await import("@/lib/priceStore/wsManager");
    getWsManager(URL_).subscribeChannel(SLAB);
    FakeWs.all[0].close(); // one failure: a retry timer is pending
    window.dispatchEvent(new Event("online"));
    expect(FakeWs.all.length).toBe(1);
  });
});
