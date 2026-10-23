// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  ConnectionLimiter, MAX_SUBSCRIPTIONS_PER_CLIENT, RateLimiter, WS_MAX_PAYLOAD_BYTES, checkSubscribe, clientKey,
  createUpgradeGate, isKnownSlab, normalizeAddress,
} from "@/lib/chart/ws-guards";

const A = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const B = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const known = new Set([A]);
const never = () => false;
const sub = (slab: unknown, over: Partial<Parameters<typeof checkSubscribe>[0]> = {}) =>
  checkSubscribe({ slab, current: new Set(), known, marketsLoaded: true, isBlocked: never, ...over });

describe("checkSubscribe", () => {
  it("accepts a known market", () => expect(sub(A)).toEqual({ ok: true }));
  it("rejects non-base58 / wrong-length / non-string (negative controls)", () => {
    for (const bad of ["", "abc", "0".repeat(44), "O" + A.slice(1), A + "x".repeat(20), 123, null, { a: 1 }, undefined]) {
      expect(sub(bad)).toEqual({ ok: false, reason: "bad-slab" });
    }
  });
  it("rejects a well-formed address that is not a market once the set is loaded; accepts it before (format only)", () => {
    expect(sub(B)).toEqual({ ok: false, reason: "unknown-slab" });
    expect(sub(B, { marketsLoaded: false })).toEqual({ ok: true });
  });
  it("rejects blocked markets even when known", () => {
    expect(sub(A, { isBlocked: (s) => s === A })).toEqual({ ok: false, reason: "unknown-slab" });
  });
  it(`allows at most ${MAX_SUBSCRIPTIONS_PER_CLIENT} subscriptions per client; re-subscribing an existing one is not a new one`, () => {
    const many = Array.from({ length: MAX_SUBSCRIPTIONS_PER_CLIENT }, (_, i) => `${A.slice(0, 40)}${"abcdefghjkmnpqrs"[i]}111`);
    const knownMany = new Set([...many, A]);
    const current = new Set(many.slice(0, MAX_SUBSCRIPTIONS_PER_CLIENT));
    expect(sub(A, { current, known: knownMany })).toEqual({ ok: false, reason: "limit" });
    expect(sub(many[0], { current, known: knownMany })).toEqual({ ok: true });
    const fewer = new Set(many.slice(0, MAX_SUBSCRIPTIONS_PER_CLIENT - 1));
    expect(sub(A, { current: fewer, known: knownMany })).toEqual({ ok: true });
  });
  it("the payload ceiling is small enough to refuse a flood message but fits a real subscribe", () => {
    expect(WS_MAX_PAYLOAD_BYTES).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify({ type: "subscribe", slabAddress: A }))).toBeLessThan(WS_MAX_PAYLOAD_BYTES);
  });
});

describe("isKnownSlab (ingest allowlist)", () => {
  it("drops unknown and blocked markets, accepts known; format-only before load", () => {
    expect(isKnownSlab(A, known, true, never)).toBe(true);
    expect(isKnownSlab(B, known, true, never)).toBe(false);
    expect(isKnownSlab(B, known, false, never)).toBe(true);
    expect(isKnownSlab(A, known, true, (s) => s === A)).toBe(false);
    expect(isKnownSlab("nope", known, false, never)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows max per window, then refuses, then recovers; keys are independent", () => {
    const rl = new RateLimiter(3, 1000);
    expect([0, 1, 2].map((i) => rl.allow("a", i))).toEqual([true, true, true]);
    expect(rl.allow("a", 10)).toBe(false);
    expect(rl.allow("b", 10)).toBe(true);
    expect(rl.allow("a", 1001)).toBe(true); // the first hit aged out
    expect(rl.allow("a", 1002)).toBe(true);
    expect(rl.allow("a", 1003)).toBe(true);
    expect(rl.allow("a", 1004)).toBe(false);
  });
  it("bounds its own memory", () => {
    const rl = new RateLimiter(1, 1000, 10);
    for (let i = 0; i < 100; i++) rl.allow(`k${i}`, i);
    expect((rl as unknown as { hits: Map<string, number[]> }).hits.size).toBeLessThanOrEqual(10);
  });
});

describe("clientKey (#3514)", () => {
  it("keys on the RIGHTMOST forwarded hop (the one the edge proxy appended), falls back to the socket", () => {
    expect(clientKey("1.2.3.4, 10.0.0.1", "9.9.9.9")).toBe("10.0.0.1");
    expect(clientKey(["5.6.7.8"], "9.9.9.9")).toBe("5.6.7.8");
    expect(clientKey(["6.6.6.6", "7.7.7.7"], "9.9.9.9")).toBe("7.7.7.7");
    expect(clientKey(undefined, "9.9.9.9")).toBe("9.9.9.9");
    expect(clientKey("", "9.9.9.9")).toBe("9.9.9.9");
    expect(clientKey(undefined, undefined)).toBe("unknown");
  });

  it("a client-written leftmost XFF entry cannot move the caller to a fresh bucket", () => {
    const real = "203.0.113.7";
    const keys = new Set(["1.1.1.1", "2.2.2.2", "spoof"].map((fake) => clientKey(`${fake}, ${real}`, "10.0.0.2")));
    expect([...keys]).toEqual([real]);
  });

  it("buckets IPv6 by /64, so rotating the interface id does not escape the limiter", () => {
    const a = clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd", undefined);
    const b = clientKey("2001:db8:1:2::1", undefined);
    const c = clientKey("2001:0db8:0001:0002:ffff:0:0:9", undefined);
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(clientKey("2001:db8:1:3::1", undefined)).not.toBe(a);
  });

  it("normalises IPv4-mapped IPv6, ports and zones", () => {
    expect(normalizeAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeAddress("192.0.2.1:4433")).toBe("192.0.2.1");
    expect(normalizeAddress("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
    expect(normalizeAddress("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(normalizeAddress("::1")).toBe("0:0:0:0::/64");
    expect(normalizeAddress("not-an-ip")).toBe("not-an-ip");
  });

  it("keeps the /ticks limiter shut for a caller that rotates its leftmost XFF entry", () => {
    const rl = new RateLimiter(2, 60_000);
    const results = ["a", "b", "c", "d"].map((fake, i) => rl.allow(clientKey(`${fake}.example, 198.51.100.4`, "10.0.0.2"), 1000 + i));
    expect(results).toEqual([true, true, false, false]);
  });
});

describe("ConnectionLimiter (#3514)", () => {
  it("caps sockets per client and releases them", () => {
    const c = new ConnectionLimiter(2, 100);
    expect(c.acquire("a")).toBe(true);
    expect(c.acquire("a")).toBe(true);
    expect(c.acquire("a")).toBe(false);
    expect(c.acquire("b")).toBe(true);
    expect(c.total).toBe(3);
    c.release("a");
    expect(c.countFor("a")).toBe(1);
    expect(c.acquire("a")).toBe(true);
  });

  it("caps sockets in total across clients", () => {
    const c = new ConnectionLimiter(10, 3);
    expect(["a", "b", "c"].map((k) => c.acquire(k))).toEqual([true, true, true]);
    expect(c.acquire("d")).toBe(false);
    c.release("b");
    expect(c.acquire("d")).toBe(true);
  });

  it("an unmatched release is a no-op (no negative counts)", () => {
    const c = new ConnectionLimiter(1, 1);
    c.release("ghost");
    expect(c.total).toBe(0);
    expect(c.acquire("a")).toBe(true);
    expect(c.acquire("b")).toBe(false);
  });
});

describe("createUpgradeGate on a real WebSocketServer (#3514)", () => {
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null; wss = null;
  });

  async function start(connections: ConnectionLimiter, upgrades = new RateLimiter(1000, 60_000)): Promise<number> {
    server = createServer();
    wss = new WebSocketServer({ server, verifyClient: createUpgradeGate({ upgrades, connections }) });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server!.address() as AddressInfo).port;
  }

  function connect(port: number, xff?: string): Promise<{ ok: boolean; status?: number; ws: WebSocket }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, xff ? { headers: { "x-forwarded-for": xff } } : undefined);
      sockets.push(ws);
      ws.once("open", () => resolve({ ok: true, ws }));
      ws.once("unexpected-response", (_req, res) => resolve({ ok: false, status: res.statusCode, ws }));
      ws.once("error", () => resolve({ ok: false, ws }));
    });
  }

  it("refuses the upgrade past the per-client cap, even with a rotated leftmost XFF, and frees the slot on close", async () => {
    const conns = new ConnectionLimiter(2, 100);
    const port = await start(conns);
    const a = await connect(port, "1.1.1.1, 198.51.100.9");
    const b = await connect(port, "2.2.2.2, 198.51.100.9");
    const c = await connect(port, "3.3.3.3, 198.51.100.9");
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    expect(c.status).toBe(503);
    // A different client is unaffected.
    expect((await connect(port, "198.51.100.10")).ok).toBe(true);

    a.ws.close();
    await new Promise<void>((r) => { const t = setInterval(() => { if (conns.countFor("198.51.100.9") === 1) { clearInterval(t); r(); } }, 5); });
    expect((await connect(port, "198.51.100.9")).ok).toBe(true);
  });

  it("refuses upgrades past the per-client rate limit with 429", async () => {
    const port = await start(new ConnectionLimiter(100, 100), new RateLimiter(2, 60_000));
    const r1 = await connect(port, "198.51.100.20");
    const r2 = await connect(port, "198.51.100.20");
    const r3 = await connect(port, "198.51.100.20");
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, false]);
    expect(r3.status).toBe(429);
  });
});
