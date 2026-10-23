/**
 * S21: the chart's live client was created once with a CAPTURED wsManager handle. The shared manager
 * is torn down after 20 s with no subscribers (e.g. the user spends 20 s on a page with no prices),
 * and the captured handle stayed bound to that dead manager: on returning to a trade page the chart
 * subscribed into it, no socket ever opened, and the strip sat at "Offline" (no candles, no Mark
 * line) until a reload, while the header price, which resolves the manager per call, kept ticking.
 * Real lib/tv/data + live-client + wsManager; only WebSocket is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";

class FakeWs {
  static all: FakeWs[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  constructor(public url: string) { FakeWs.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; this.onclose?.(); }
  open() { this.onopen?.(); }
  tick(seq: number) {
    this.onmessage?.({ data: JSON.stringify({ type: "tick", slab: SLAB, epoch: "e1", seq, slot: seq, landedMs: seq, mark: 1.5, oracle: 1.5 }) });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWs.all = [];
  vi.stubGlobal("WebSocket", FakeWs);
  vi.stubEnv("NEXT_PUBLIC_WS_URL", "ws://live.test");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function liveClient() {
  const { getLiveClient } = await import("@/lib/tv/data");
  return getLiveClient()!;
}

describe("chart live client after the shared socket's idle teardown", () => {
  it("returning after 20 s+ without subscribers opens a new socket and ticks reach the chart again", async () => {
    const client = await liveClient();
    const first = vi.fn();
    const off = client.subscribe(SLAB, { onTick: first });
    FakeWs.all[0].open();
    FakeWs.all[0].tick(1);
    expect(first).toHaveBeenCalledTimes(1);

    off(); // left the trade page for one without prices
    vi.advanceTimersByTime(21_000);
    expect(FakeWs.all[0].closed).toBe(true); // idle teardown still happens

    const again = vi.fn();
    const onReconnect = vi.fn();
    client.subscribe(SLAB, { onTick: again, onReconnect }); // back on a trade page, same cached client
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1].open();
    expect(onReconnect).toHaveBeenCalled(); // the strip's signal to go live and re-read history
    FakeWs.all[1].tick(1);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("re-subscribing inside the 20 s window cancels the pending teardown (one socket, still live)", async () => {
    const client = await liveClient();
    const off = client.subscribe(SLAB, { onTick: () => {} });
    FakeWs.all[0].open();
    off();
    vi.advanceTimersByTime(10_000);
    const again = vi.fn();
    client.subscribe(SLAB, { onTick: again });
    vi.advanceTimersByTime(15_000); // past the original 20 s deadline
    expect(FakeWs.all).toHaveLength(1);
    expect(FakeWs.all[0].closed).toBe(false);
    FakeWs.all[0].tick(1);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("creating the client no longer opens a socket by itself; the first chart subscribe does", async () => {
    await liveClient();
    expect(FakeWs.all).toHaveLength(0);
  });
});
