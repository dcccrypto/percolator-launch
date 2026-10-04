// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_SUBSCRIPTIONS_PER_CLIENT, RateLimiter, WS_MAX_PAYLOAD_BYTES, checkSubscribe, clientKey, isKnownSlab,
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

describe("clientKey", () => {
  it("prefers the first forwarded hop, falls back to the socket", () => {
    expect(clientKey("1.2.3.4, 10.0.0.1", "9.9.9.9")).toBe("1.2.3.4");
    expect(clientKey(["5.6.7.8"], "9.9.9.9")).toBe("5.6.7.8");
    expect(clientKey(undefined, "9.9.9.9")).toBe("9.9.9.9");
    expect(clientKey(undefined, undefined)).toBe("unknown");
  });
});
