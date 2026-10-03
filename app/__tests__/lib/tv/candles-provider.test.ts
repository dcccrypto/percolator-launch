import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMarkTick, applyTrade, bucketStart, normalizeBars, type ProviderBar } from "@/lib/tv/data/provider";
import { HISTORY_PROBE_INTERVAL_MS, createCandlesApiProvider, parseUdf, type MarkStream } from "@/lib/tv/data/candlesApiProvider";
import { createTradeStream, parseTradeMessage, type LiveTrade, type TradeStream } from "@/lib/tv/data/tradeStream";

const SLAB = "HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop";
const b = (timeSec: number, close: number, volume = 1): ProviderBar => ({ timeSec, open: close, high: close, low: close, close, volume });

describe("provider bar helpers", () => {
  it("normalizeBars sorts, de-duplicates (later wins), drops unpriced/non-finite bars, coerces volume", () => {
    const out = normalizeBars([
      b(120, 2),
      b(60, 1),
      { ...b(60, 9), volume: NaN },
      { ...b(180, 0) }, // zero price (liquidation marker bucket)
      { ...b(240, 3), high: Infinity },
    ]);
    expect(out.map((x) => [x.timeSec, x.close, x.volume])).toEqual([
      [60, 9, 0],
      [120, 2, 1],
    ]);
  });

  it("applyTrade opens a new bucket, folds into the current one, ignores stale and unpriced trades", () => {
    const first = applyTrade(null, { price: 10, size: -2, tsSec: 125 }, "1");
    expect(first).toEqual({ timeSec: 120, open: 10, high: 10, low: 10, close: 10, volume: 2 });
    const same = applyTrade(first, { price: 12, size: 1, tsSec: 170 }, "1");
    expect(same).toEqual({ timeSec: 120, open: 10, high: 12, low: 10, close: 12, volume: 3 });
    const next = applyTrade(same, { price: 8, size: 1, tsSec: 185 }, "1");
    expect(next?.timeSec).toBe(180);
    expect(applyTrade(next, { price: 9, size: 1, tsSec: 100 }, "1")).toBeNull();
    expect(applyTrade(next, { price: 0, size: 1, tsSec: 200 }, "1")).toBeNull();
    expect(applyTrade(next, { price: NaN, size: 1, tsSec: 200 }, "1")).toBeNull();
  });

  it("mark ticks never mutate a trade- or DEX-built series", () => {
    const last = b(3600, 5);
    expect(applyMarkTick("percolator", last, { price: 6, tsSec: 3700 }, "60")).toBeNull();
    expect(applyMarkTick("dex", last, { price: 6, tsSec: 3700 }, "60")).toBeNull();
    expect(applyMarkTick(null, last, { price: 6, tsSec: 3700 }, "60")).toBeNull();
    expect(applyMarkTick("oracle", last, { price: 6, tsSec: 3700 }, "60")).toMatchObject({ close: 6, high: 6, volume: 1 });
  });

  it("bucketStart aligns to the resolution", () => {
    expect(bucketStart(86_400 * 3 + 5, "1D")).toBe(86_400 * 3);
    expect(bucketStart(14_401, "240")).toBe(14_400);
  });
});

describe("parseUdf", () => {
  it("parses ok / no_data and throws on error", () => {
    expect(parseUdf({ s: "ok", t: [60, 0], o: [1, 1], h: [1, 1], l: [1, 1], c: [1, 1], v: [2, 3] }).map((x) => x.timeSec)).toEqual([0, 60]);
    expect(parseUdf({ s: "no_data" })).toEqual([]);
    expect(() => parseUdf({ s: "error", errmsg: "x" })).toThrow("x");
    expect(() => parseUdf(null)).toThrow();
  });
});

type Resp = { ok: boolean; status: number; json(): Promise<unknown> };
const json = (body: unknown, status = 200): Resp => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const udf = (bars: ProviderBar[]) => ({
  s: bars.length ? "ok" : "no_data",
  t: bars.map((x) => x.timeSec),
  o: bars.map((x) => x.open),
  h: bars.map((x) => x.high),
  l: bars.map((x) => x.low),
  c: bars.map((x) => x.close),
  v: bars.map((x) => x.volume),
});

function harness(route: (url: string) => Resp | Promise<Resp>) {
  const urls: string[] = [];
  const tradeListeners: Array<(t: LiveTrade) => void> = [];
  const markListeners: Array<(p: number, ts: number) => void> = [];
  const trades: TradeStream = {
    subscribe: (_slab, l) => {
      tradeListeners.push(l);
      return () => tradeListeners.splice(tradeListeners.indexOf(l), 1);
    },
  };
  const marks: MarkStream = {
    subscribe: (_slab, l) => {
      markListeners.push(l);
      return () => markListeners.splice(markListeners.indexOf(l), 1);
    },
    latest: () => 0.5,
  };
  const provider = createCandlesApiProvider({
    fetchImpl: async (u) => {
      urls.push(u);
      return route(u);
    },
    trades,
    marks,
  });
  return { provider, urls, tradeListeners, markListeners };
}

const req = (over: Partial<Parameters<ReturnType<typeof createCandlesApiProvider>["getBars"]>[0]> = {}) => ({
  slab: SLAB,
  resolution: "60" as const,
  fromSec: 36_000,
  toSec: 72_000,
  countBack: 10,
  firstRequest: true,
  ...over,
});

describe("candles-api provider", () => {
  afterEach(() => vi.useRealTimers());

  it("widens `from` to cover countBack, returns percolator bars", async () => {
    const h = harness(() => json(udf([b(3600 * 15, 1), b(3600 * 16, 2)])));
    const page = await h.provider.getBars(req({ fromSec: 70_000, countBack: 10 }));
    expect(h.urls[0]).toBe(`/api/candles/${SLAB}?resolution=60&from=${72_000 - 36_000}&to=72000`);
    expect(page.source).toBe("percolator");
    expect(page.noMoreHistory).toBe(false);
    expect(page.bars).toHaveLength(2);
  });

  it("an empty window gets ONE older look; empty again -> no more history", async () => {
    const h = harness(() => json(udf([])));
    const page = await h.provider.getBars(req({ firstRequest: false }));
    expect(h.urls).toHaveLength(2);
    expect(page).toEqual({ bars: [], noMoreHistory: true, source: "percolator" });
    const older = harness((u) => (u.includes("to=36000") ? json(udf([b(3600 * 5, 1)])) : json(udf([]))));
    const p2 = await older.provider.getBars(req({ firstRequest: false }));
    expect(p2.bars).toHaveLength(1);
    expect(p2.noMoreHistory).toBe(false);
  });

  it("a market with no trades charts the live mark (source oracle)", async () => {
    const h = harness(() => json(udf([])));
    const page = await h.provider.getBars(req());
    expect(page.source).toBe("oracle");
    expect(page.noMoreHistory).toBe(true);
  });

  it("404 = no candles backend: stop calling for the session", async () => {
    const h = harness(() => json({}, 404));
    await h.provider.getBars(req());
    const n = h.urls.length;
    const page = await h.provider.getBars(req());
    expect(h.urls.length).toBe(n);
    expect(page.source).toBe("oracle");
  });

  it("503 on the first request degrades to the live mark; on scroll-back it is an error", async () => {
    const h = harness(() => json({ s: "error", errmsg: "down" }, 503));
    await expect(h.provider.getBars(req())).resolves.toEqual({ bars: [], noMoreHistory: true, source: "oracle" });
    await expect(h.provider.getBars(req({ firstRequest: false }))).rejects.toThrow("503");
  });

  it("oracle mode: marks build bars, the first real trade asks for a reset (once)", () => {
    const h = harness(() => json(udf([])));
    const onBar = vi.fn();
    const onReset = vi.fn();
    const off = h.provider.subscribeBars(SLAB, "1", { onBar, onReset }, null, "oracle");
    h.markListeners[0](1.5, 125);
    h.markListeners[0](1.7, 130);
    expect(onBar).toHaveBeenLastCalledWith({ timeSec: 120, open: 1.5, high: 1.7, low: 1.5, close: 1.7, volume: 0 });
    h.tradeListeners[0]({ price: 2, size: 1, tsSec: 140 });
    h.tradeListeners[0]({ price: 2, size: 1, tsSec: 141 });
    expect(onReset).toHaveBeenCalledTimes(1);
    off();
    expect(h.markListeners).toHaveLength(0);
    expect(h.tradeListeners).toHaveLength(0);
  });

  it("percolator mode: trades extend the last bar, marks are not even subscribed", () => {
    const h = harness(() => json(udf([])));
    const onBar = vi.fn();
    h.provider.subscribeBars(SLAB, "1", { onBar }, b(120, 1, 4), "percolator");
    expect(h.markListeners).toHaveLength(0);
    h.tradeListeners[0]({ price: 3, size: 2, tsSec: 150 });
    expect(onBar).toHaveBeenCalledWith({ timeSec: 120, open: 1, high: 3, low: 1, close: 3, volume: 6 });
  });

  it("oracle mode probes history and resets once it exists", async () => {
    vi.useFakeTimers();
    let haveHistory = false;
    const h = harness(() => json(udf(haveHistory ? [b(3600, 1)] : [])));
    const onReset = vi.fn();
    const off = h.provider.subscribeBars(SLAB, "60", { onBar: vi.fn(), onReset }, null, "oracle");
    await vi.advanceTimersByTimeAsync(HISTORY_PROBE_INTERVAL_MS);
    expect(onReset).not.toHaveBeenCalled();
    haveHistory = true;
    await vi.advanceTimersByTimeAsync(HISTORY_PROBE_INTERVAL_MS);
    expect(onReset).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HISTORY_PROBE_INTERVAL_MS * 3);
    expect(onReset).toHaveBeenCalledTimes(1);
    off();
  });

  it("resolveSymbol strips -PERP, falls back to a short address and the live mark", async () => {
    const h = harness((u) => (u.startsWith("/api/markets/") ? json({ market: { symbol: "sol-perp", name: null, mark_price: 151.2 } }) : json({})));
    await expect(h.provider.resolveSymbol(SLAB)).resolves.toMatchObject({ symbol: "SOL", description: "SOL perpetual", referencePrice: 151.2 });
    const h2 = harness(() => json({}, 500));
    await expect(h2.provider.resolveSymbol(SLAB)).resolves.toMatchObject({ symbol: "HBU9…dpop", referencePrice: 0.5 });
  });

  it("searchSymbols filters the market list by symbol or address prefix", async () => {
    const h = harness(() =>
      json({ markets: [{ slab_address: SLAB, symbol: "SOL-PERP", name: "Solana", mark_price: 1 }, { slab_address: "AAA", symbol: "JUP" }, { symbol: "X" }] }),
    );
    expect((await h.provider.searchSymbols("so")).map((m) => m.symbol)).toEqual(["SOL"]);
    expect((await h.provider.searchSymbols("hbu9")).map((m) => m.slab)).toEqual([SLAB]);
    expect(await h.provider.searchSymbols("")).toHaveLength(2);
  });
});

describe("trade stream", () => {
  it("parses only priced trade messages for the slab", () => {
    expect(parseTradeMessage(JSON.stringify({ type: "trade", slab: SLAB, price: 2, size: "-3", timestamp: 61_000 }), SLAB)).toEqual({ price: 2, size: 3, tsSec: 61 });
    expect(parseTradeMessage({ type: "trade", slab: "other", price: 2, size: 1 }, SLAB)).toBeNull();
    expect(parseTradeMessage({ type: "trade", slab: SLAB, price: null, size: 1 }, SLAB)).toBeNull();
    expect(parseTradeMessage({ type: "price", slab: SLAB, price: 2 }, SLAB)).toBeNull();
    expect(parseTradeMessage("not json", SLAB)).toBeNull();
  });

  it("one socket per slab, subscribes on open, fans out, reconnects, closes on last release", () => {
    vi.useFakeTimers();
    const sockets: Array<{ sent: string[]; closed: boolean; onopen: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; send(d: string): void; close(): void }> = [];
    const stream = createTradeStream("wss://x", () => {
      const s = {
        sent: [] as string[],
        closed: false,
        onopen: null as (() => void) | null,
        onmessage: null as ((e: { data: unknown }) => void) | null,
        onclose: null as (() => void) | null,
        onerror: null as (() => void) | null,
        send(d: string) {
          this.sent.push(d);
        },
        close() {
          this.closed = true;
        },
      };
      sockets.push(s);
      return s;
    });
    const a = vi.fn();
    const c = vi.fn();
    const offA = stream.subscribe(SLAB, a);
    const offC = stream.subscribe(SLAB, c);
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: "subscribe", channels: [`trades:${SLAB}`] });
    sockets[0].onmessage?.({ data: JSON.stringify({ type: "trade", slab: SLAB, price: 1, size: 1, timestamp: 1000 }) });
    expect(a).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
    sockets[0].onclose?.();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    offA();
    expect(sockets[1].closed).toBe(false);
    offC();
    expect(sockets[1].closed).toBe(true);
    vi.useRealTimers();
  });

  it("no URL -> inert", () => {
    const stream = createTradeStream(null, () => {
      throw new Error("must not connect");
    });
    expect(() => stream.subscribe(SLAB, vi.fn())()).not.toThrow();
  });
});
