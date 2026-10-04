// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createLiveClient, parseTick, parseTrade, wsToHttpBase, type WsLike, type WsStatus } from "@/lib/chart/live-client";
import type { TickMessage } from "@/lib/chart/perp-types";

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const tk = (seq: number, epoch = "e1", mark: number | null = 1, oracle: number | null = 1): TickMessage =>
  ({ type: "tick", slab: SLAB, epoch, seq, slot: 10 + seq, landedMs: 1_000 + seq * 1500, recvMs: 1_010 + seq * 1500, mark, oracle });

function fakeWs(initial: WsStatus = "open") {
  let status = initial;
  const msg = new Set<(d: unknown) => void>();
  const st = new Set<(s: WsStatus) => void>();
  const ws: WsLike = {
    subscribeChannel: vi.fn(() => () => {}),
    onMessageForChannel: (_c, l) => { msg.add(l); return () => msg.delete(l); },
    onStatusChange: (l) => { st.add(l); return () => st.delete(l); },
    getStatus: () => status,
  };
  return {
    ws,
    send: (d: unknown) => msg.forEach((l) => l(d)),
    setStatus: (s: WsStatus) => { status = s; st.forEach((l) => l(s)); },
    listeners: () => msg.size + st.size,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("parseTick / parseTrade", () => {
  it("accepts a good tick and rejects malformed ones", () => {
    expect(parseTick(tk(1))).toMatchObject({ seq: 1, mark: 1 });
    expect(parseTick({ ...tk(1), mark: 0 })).toBeNull();
    expect(parseTick({ ...tk(1), mark: null, oracle: null })).toBeNull();
    expect(parseTick({ ...tk(1), seq: 1.5 })).toBeNull();
    expect(parseTick({ ...tk(1), type: "price" })).toBeNull();
    expect(parseTick(null)).toBeNull();
    expect(parseTick({ ...tk(1), mark: NaN })).toBeNull();
  });
  it("trade parsing drops non-positive prices", () => {
    expect(parseTrade({ type: "trade", slab: SLAB, id: "1", price: 2, size: 3, side: "long", ts: 5 })).toMatchObject({ price: 2, side: "long" });
    expect(parseTrade({ type: "trade", slab: SLAB, id: "1", price: 0, size: 3, ts: 5 })).toBeNull();
  });
  it("derives the http base from the ws url", () => {
    expect(wsToHttpBase("wss://x.up.railway.app/")).toBe("https://x.up.railway.app");
    expect(wsToHttpBase("ws://localhost:8787")).toBe("http://localhost:8787");
  });
});

describe("createLiveClient", () => {
  it("delivers ticks in order, once", () => {
    const f = fakeWs();
    const got: number[] = [];
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson: vi.fn() }).subscribe(SLAB, { onTick: (m) => got.push(m.seq) });
    for (const s of [1, 2, 2, 3, 1]) f.send(tk(s));
    expect(got).toEqual([1, 2, 3]);
  });
  it("repairs a seq gap from /ticks and delivers the held live tick after the repair, in order", async () => {
    const f = fakeWs();
    const got: number[] = [];
    const fetchJson = vi.fn(async () => ({ ok: true, json: async () => ({ epoch: "e1", ticks: [tk(2), tk(3)] }) }));
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson }).subscribe(SLAB, { onTick: (m) => got.push(m.seq) });
    f.send(tk(1));
    f.send(tk(4)); // 2 and 3 were lost
    await flush();
    expect(fetchJson).toHaveBeenCalledWith(expect.stringContaining("/ticks?slab=" + SLAB + "&sinceSeq=1&epoch=e1"));
    expect(got).toEqual([1, 2, 3, 4]);
  });
  it("a failed repair delivers the held tick (gap acknowledged), signals a tail re-read, and never loops", async () => {
    const f = fakeWs();
    const got: number[] = [];
    const onReconnect = vi.fn();
    const fetchJson = vi.fn(async () => { throw new Error("net"); });
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson }).subscribe(SLAB, { onTick: (m) => got.push(m.seq), onReconnect });
    f.send(tk(1));
    f.send(tk(3));
    await flush();
    await flush();
    expect(got).toEqual([1, 3]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    f.send(tk(4));
    expect(got).toEqual([1, 3, 4]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("a new epoch (server restart) is a fresh baseline and fires onReconnect", () => {
    const f = fakeWs();
    const got: string[] = [];
    const onReconnect = vi.fn();
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson: vi.fn() }).subscribe(SLAB, { onTick: (m) => got.push(`${m.epoch}:${m.seq}`), onReconnect });
    f.send(tk(5, "e1"));
    f.send(tk(1, "e2"));
    f.send(tk(2, "e2"));
    expect(got).toEqual(["e1:5", "e2:1", "e2:2"]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
  it("replays after a socket reconnect, then fires onReconnect", async () => {
    const f = fakeWs();
    const got: number[] = [];
    const onReconnect = vi.fn();
    const fetchJson = vi.fn(async () => ({ ok: true, json: async () => ({ epoch: "e1", ticks: [tk(2), tk(3)] }) }));
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson }).subscribe(SLAB, { onTick: (m) => got.push(m.seq), onReconnect });
    f.send(tk(1));
    f.setStatus("closed");
    f.setStatus("open");
    await flush();
    expect(got).toEqual([1, 2, 3]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
  it("de-dupes trades by id and ignores them without a trade handler", () => {
    const f = fakeWs();
    const trades: string[] = [];
    createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson: vi.fn() }).subscribe(SLAB, { onTick: () => {}, onTrade: (t) => trades.push(t.id) });
    const t = { type: "trade", slab: SLAB, id: "a", price: 1, size: 1, side: "long", ts: 1 };
    f.send(t); f.send(t); f.send({ ...t, id: "b" });
    expect(trades).toEqual(["a", "b"]);
  });
  it("unsubscribe detaches every listener and releases the channel", () => {
    const f = fakeWs();
    const off = createLiveClient({ ws: f.ws, httpBase: "http://x", fetchJson: vi.fn() }).subscribe(SLAB, { onTick: () => {} });
    expect(f.listeners()).toBe(2);
    off();
    expect(f.listeners()).toBe(0);
  });
});
