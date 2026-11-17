/**
 * Reconnect-cap audit of wsManager (fake timers + fake WebSocket):
 *  1. after the breaker trips the status is "closed" (not stuck connecting) and revive resets budget+delay
 *  2. a successful open resets the backoff delay to the base
 *  3. new WebSocket() throwing synchronously schedules a reconnect, counts one attempt, and
 *     leaves status "closed" (not "connecting") once the breaker trips so revive still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const URL_ = "ws://cap.test";
const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

let throwOnCreate = false;
let created = 0;
class FakeWs {
  static all: FakeWs[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    created++;
    if (throwOnCreate) throw new Error("SecurityError");
    FakeWs.all.push(this);
  }
  send() {}
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
}

const added: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWs.all = [];
  throwOnCreate = false;
  created = 0;
  vi.stubGlobal("WebSocket", FakeWs);
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

describe("lead 1: status once the breaker trips", () => {
  it("is 'closed' after closes exhaust the budget, and revive resets attempts + delay", async () => {
    const { getWsManager } = await import("@/lib/priceStore/wsManager");
    const h = getWsManager(URL_);
    h.subscribeChannel(SLAB);
    for (let i = 0; i < 40; i++) {
      const n = FakeWs.all.length;
      FakeWs.all[n - 1].close();
      vi.advanceTimersByTime(40_000);
      if (FakeWs.all.length === n) break;
    }
    expect(FakeWs.all.length).toBe(11);
    expect(h.getStatus()).toBe("closed");
    window.dispatchEvent(new Event("online"));
    const n = FakeWs.all.length;
    FakeWs.all[n - 1].close();
    // base delay (<=1.25s), not the 30s cap
    vi.advanceTimersByTime(1_300);
    expect(FakeWs.all.length).toBe(n + 1);
  });
});

describe("lead 2: delay reset on open", () => {
  it("one flap after growth does not leave later reconnects at the max delay", async () => {
    const { getWsManager } = await import("@/lib/priceStore/wsManager");
    const h = getWsManager(URL_);
    h.subscribeChannel(SLAB);
    for (let i = 0; i < 6; i++) {
      FakeWs.all[FakeWs.all.length - 1].close();
      vi.advanceTimersByTime(40_000);
    }
    FakeWs.all[FakeWs.all.length - 1].open();
    expect(h.getStatus()).toBe("open");
    FakeWs.all[FakeWs.all.length - 1].close();
    const n = FakeWs.all.length;
    vi.advanceTimersByTime(1_300);
    expect(FakeWs.all.length).toBe(n + 1);
  });
});

describe("lead 3: constructor throws synchronously", () => {
  it("schedules reconnects, counts one attempt each (10 retries then stops)", async () => {
    throwOnCreate = true;
    const { getWsManager } = await import("@/lib/priceStore/wsManager");
    getWsManager(URL_).subscribeChannel(SLAB);
    expect(created).toBe(1);
    for (let i = 0; i < 40; i++) vi.advanceTimersByTime(40_000);
    expect(created).toBe(11); // first attempt + 10 retries, no double counting
  });

  it("reports 'closed' once the breaker trips, and revive recovers", async () => {
    throwOnCreate = true;
    const { getWsManager } = await import("@/lib/priceStore/wsManager");
    const h = getWsManager(URL_);
    h.subscribeChannel(SLAB);
    for (let i = 0; i < 40; i++) vi.advanceTimersByTime(40_000);
    expect(h.getStatus()).toBe("closed");
    throwOnCreate = false;
    window.dispatchEvent(new Event("online"));
    expect(FakeWs.all.length).toBe(1);
  });
});
