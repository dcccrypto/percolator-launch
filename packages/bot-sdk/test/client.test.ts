import { describe, expect, it } from "vitest";
import { BotApiError, BotClient, parseSse, type FetchLike } from "../src/index";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const KEY = "pbk_AAAAAAAAAAAA_" + "B".repeat(43);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const envelope = (code: string, retryable: boolean, extra: object = {}) => ({ error: { code, message: `m ${code}`, retryable, ...extra } });

function mock(replies: Array<Response | Error | (() => Response)>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  };
  return { f, calls };
}

function client(f: FetchLike, extra: object = {}) {
  const sleeps: number[] = [];
  const c = new BotClient({ baseUrl: "http://x.test/", apiKey: KEY, fetch: f, random: () => 1, sleep: async (ms) => void sleeps.push(ms), ...extra });
  return { c, sleeps };
}

describe("reads", () => {
  it("builds urls, sends the key as a bearer token and returns the body", async () => {
    const { f, calls } = mock([json(200, { slot: 1 })]);
    const { c } = client(f);
    await c.quote("M1", { size: -5n, slippageBps: 50 });
    await c.history("W1", { limit: 10 });
    await c.account("W1", {});
    expect(calls[0].url).toBe("http://x.test/api/v1/markets/M1/quote?size=-5&slippageBps=50");
    expect(calls[1].url).toBe("http://x.test/api/v1/accounts/W1/history?limit=10");
    expect(calls[2].url).toBe("http://x.test/api/v1/accounts/W1");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].method).toBe("GET");
  });
  it("sends no auth header without a key", async () => {
    const { f, calls } = mock([json(200, {})]);
    await new BotClient({ baseUrl: "http://x.test", fetch: f }).markets();
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("errors", () => {
  it("raises BotApiError with code, retryable, onchain, logs and request id", async () => {
    const { f } = mock([json(422, envelope("insufficient_margin", false, { onchain: { code: 49, name: "EngineInsufficientInitialMargin" }, logs: ["l1"] }), { "x-request-id": "rid-1" })]);
    const { c } = client(f);
    const e = await c.buildOrder({ owner: "o", market: "m", side: "buy", size: "1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BotApiError);
    const err = e as BotApiError;
    expect(err).toMatchObject({ code: "insufficient_margin", status: 422, retryable: false, requestId: "rid-1", logs: ["l1"] });
    expect(err.onchain).toEqual({ code: 49, name: "EngineInsufficientInitialMargin" });
  });
  it("does not retry a non-retryable error", async () => {
    const { f, calls } = mock([json(409, envelope("idempotency_conflict", false))]);
    const { c, sleeps } = client(f);
    await expect(c.markets()).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });
  it("maps a non-envelope failure to bad_response, retryable only for 5xx", async () => {
    const { f } = mock([new Response("<html>bad gateway</html>", { status: 502 })]);
    const { c } = client(f, { maxRetries: 0 });
    await expect(c.markets()).rejects.toMatchObject({ code: "bad_response", status: 502, retryable: true });
    const m2 = mock([new Response("nope", { status: 404 })]);
    await expect(client(m2.f).c.markets()).rejects.toMatchObject({ code: "bad_response", retryable: false });
  });
});

describe("retry", () => {
  it("retries retryable codes with exponential backoff, then succeeds", async () => {
    const { f, calls } = mock([json(503, envelope("rpc_unavailable", true)), json(503, envelope("rpc_unavailable", true)), json(200, { ok: 1 })]);
    const { c, sleeps } = client(f);
    expect(await c.markets()).toEqual({ ok: 1 });
    expect(calls.length).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });
  it("honors Retry-After on 429", async () => {
    const { f, calls } = mock([json(429, envelope("rate_limited", true), { "retry-after": "7" }), json(200, {})]);
    const { c, sleeps } = client(f);
    await c.markets();
    expect(sleeps).toEqual([7000]);
    expect(calls.length).toBe(2);
  });
  it("gives up when Retry-After is longer than maxDelayMs", async () => {
    const { f, calls } = mock([json(429, envelope("rate_limited", true), { "retry-after": "60" })]);
    const { c } = client(f, { maxDelayMs: 5000 });
    await expect(c.markets()).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 60000 });
    expect(calls.length).toBe(1);
  });
  it("stops after maxRetries and throws the last error", async () => {
    const { f, calls } = mock([json(503, envelope("market_unreadable", true))]);
    const { c } = client(f, { maxRetries: 2 });
    await expect(c.markets()).rejects.toMatchObject({ code: "market_unreadable" });
    expect(calls.length).toBe(3);
  });
  it("retries network errors", async () => {
    const { f, calls } = mock([new TypeError("fetch failed"), json(200, { a: 1 })]);
    const { c } = client(f);
    expect(await c.markets()).toEqual({ a: 1 });
    expect(calls.length).toBe(2);
  });
});

describe("builders", () => {
  const req = { owner: "o", market: "m", side: "buy" as const, size: "100" };
  const built = { transactions: [], blockhash: "bh", lastValidBlockHeight: 9, resubmitAfter: false, summary: {} };
  it("sets an Idempotency-Key and reuses it across retries", async () => {
    const { f, calls } = mock([json(503, envelope("rpc_unavailable", true)), json(200, built)]);
    const { c } = client(f);
    const r = await c.buildOrder(req);
    expect(calls.length).toBe(2);
    const k = calls[0].headers["Idempotency-Key"];
    expect(k).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(calls[1].headers["Idempotency-Key"]).toBe(k);
    expect(r.idempotencyKey).toBe(k);
    expect(JSON.parse(calls[0].body!)).toEqual(req);
    expect(calls[0].url).toBe("http://x.test/api/v1/orders");
  });
  it("uses a new key per call, or the caller's", async () => {
    const { f, calls } = mock([json(200, built)]);
    const { c } = client(f);
    await c.buildOrder(req);
    await c.buildOrder(req);
    await c.buildClose({ owner: "o", market: "m" }, { idempotencyKey: "my-fixed-key-1" });
    expect(calls[0].headers["Idempotency-Key"]).not.toBe(calls[1].headers["Idempotency-Key"]);
    expect(calls[2].headers["Idempotency-Key"]).toBe("my-fixed-key-1");
    expect(calls[2].url).toBe("http://x.test/api/v1/positions/close");
  });
  it("routes deposit, withdraw and cancel", async () => {
    const { f, calls } = mock([json(200, built)]);
    const { c } = client(f);
    await c.buildDeposit({ owner: "o", market: "m", amount: "5" });
    await c.buildWithdraw({ owner: "o", market: "m", amount: "5" });
    await c.cancelOrder("my-fixed-key-1");
    expect(calls.map((x) => x.url.replace("http://x.test", ""))).toEqual(["/api/v1/deposits", "/api/v1/withdrawals", "/api/v1/orders/cancel"]);
    expect(JSON.parse(calls[2].body!)).toEqual({ idempotencyKey: "my-fixed-key-1" });
    expect(calls[2].headers["Idempotency-Key"]).toBeUndefined();
  });
  it("never sends anything but JSON bodies the caller gave (no signing material)", async () => {
    const { f, calls } = mock([json(200, built)]);
    await client(f).c.buildOrder(req);
    expect(Object.keys(calls[0].headers).sort()).toEqual(["Accept", "Authorization", "Content-Type", "Idempotency-Key"]);
  });
});

describe("waitForTx", () => {
  const st = (status: string) => json(200, { signature: "s", status, slot: 1, confirmations: null, err: null, blockHeight: 5, lastValidBlockHeight: 10, observedAt: "t" });
  it("polls until confirmed", async () => {
    const { f, calls } = mock([st("pending"), st("processed"), st("confirmed")]);
    const { c, sleeps } = client(f);
    const seen: string[] = [];
    const r = await c.waitForTx("SIG", { lastValidBlockHeight: 10, intervalMs: 10, onUpdate: (s) => seen.push(s.status) });
    expect(r.status).toBe("confirmed");
    expect(seen).toEqual(["pending", "processed", "confirmed"]);
    expect(sleeps).toEqual([10, 10]);
    expect(calls[0].url).toBe("http://x.test/api/v1/tx/SIG?lastValidBlockHeight=10");
  });
  it("returns failed and expired as results", async () => {
    expect((await client(mock([st("failed")]).f).c.waitForTx("S")).status).toBe("failed");
    expect((await client(mock([st("expired")]).f).c.waitForTx("S")).status).toBe("expired");
  });
  it("waits for finalized when asked", async () => {
    const { f } = mock([st("confirmed"), st("finalized")]);
    expect((await client(f).c.waitForTx("S", { until: "finalized", intervalMs: 1 })).status).toBe("finalized");
  });
  it("times out with a timeout error", async () => {
    const { f } = mock([st("pending")]);
    await expect(client(f).c.waitForTx("S", { intervalMs: 50, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });
});

const enc = new TextEncoder();
function sseResponse(blocks: string[], hold = false): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (sent) {
          if (!hold) ctl.close();
          return new Promise(() => undefined);
        }
        sent = true;
        for (const b of blocks) ctl.enqueue(enc.encode(b));
        if (!hold) ctl.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}
const ev = (event: string, id: number | null, data: unknown) => `event: ${event}\n${id === null ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;

describe("parseSse", () => {
  it("handles split chunks, CRLF, comments and retry", async () => {
    const parts = ["retry: 1500\n\nevent: market\nid: 7\nda", "ta: {\"a\":1}\r\n\r\n: ping\n\nevent: heartbeat\ndata: {}\n\n"];
    const body = new ReadableStream<Uint8Array>({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
    const out = [];
    for await (const e of parseSse(body)) out.push(e);
    expect(out).toEqual([
      { event: "message", id: null, data: "", retry: 1500 },
      { event: "market", id: "7", data: '{"a":1}', retry: null },
      { event: "heartbeat", id: null, data: "{}", retry: null },
    ]);
  });
});

describe("stream", () => {
  it("yields events, reconnects on end with Last-Event-ID, and stops on abort", async () => {
    const { f, calls } = mock([
      () => sseResponse(["retry: 100\n\n", ev("market", 10, { market: "M", slot: 10 }), ev("heartbeat", 10, { slot: 10 }), ev("end", null, { reason: "max-duration", reconnect: true, lastEventId: "10" })]),
      () => sseResponse([ev("market", 12, { market: "M", slot: 12 })], true),
    ]);
    const { c, sleeps } = client(f);
    const ctl = new AbortController();
    const got: string[] = [];
    for await (const e of c.stream(["M"], { signal: ctl.signal })) {
      got.push(`${e.type}:${e.id}`);
      if (e.type === "market" && e.id === "12") ctl.abort();
    }
    expect(got).toEqual(["market:10", "heartbeat:10", "market:12"]);
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe("http://x.test/api/v1/stream?markets=M");
    expect(calls[0].headers["Last-Event-ID"]).toBeUndefined();
    expect(calls[1].headers["Last-Event-ID"]).toBe("10");
    expect(sleeps).toEqual([]); // an `end` event reconnects at once
  });
  it("reconnects after a dropped connection using the retry hint, and after a retryable HTTP error", async () => {
    const { f, calls } = mock([
      () => sseResponse(["retry: 300\n\n", ev("market", 5, { market: "M", slot: 5 })]),
      () => json(503, envelope("rpc_unavailable", true)),
      () => sseResponse([ev("market", 6, { market: "M", slot: 6 })], true),
    ]);
    const { c, sleeps } = client(f);
    const ctl = new AbortController();
    const ids: Array<string | null> = [];
    for await (const e of c.stream(["M"], { signal: ctl.signal })) {
      ids.push(e.id);
      if (e.id === "6") ctl.abort();
    }
    expect(ids).toEqual(["5", "6"]);
    expect(calls.map((x) => x.headers["Last-Event-ID"])).toEqual([undefined, "5", "5"]);
    expect(sleeps).toEqual([300, 300]);
  });
  it("throws a non-retryable API error and honors maxReconnects", async () => {
    const bad = mock([json(404, envelope("market_not_found", false))]);
    await expect(client(bad.f).c.stream(["M"]).next()).rejects.toMatchObject({ code: "market_not_found" });
    const cut = mock([() => sseResponse([ev("market", 1, { market: "M", slot: 1 })])]);
    const out: string[] = [];
    for await (const e of client(cut.f).c.stream(["M"], { maxReconnects: 1 })) out.push(String(e.id));
    expect(out).toEqual(["1", "1"]);
    expect(cut.calls.length).toBe(2);
  });
});
