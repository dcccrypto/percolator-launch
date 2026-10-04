// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_AGE_MS, MAX_FUTURE_SKEW_MS, bearerMatches, e6ToUsd, parseIngestBody } from "@/lib/chart/tick-ingest";

const NOW = 1_791_000_000_000;
const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const tick = (over: Record<string, unknown> = {}) => ({ slab: SLAB, assetIndex: 0, slot: 123, landedMs: NOW - 100, markE6: "3461", oracleE6: "3460", ...over });
const body = (ticks: unknown[], over: Record<string, unknown> = {}) => ({ v: 1, src: "keeper", sentMs: NOW, ticks, ...over });

describe("bearerMatches", () => {
  const key = "k".repeat(32);
  it("accepts only the exact bearer token", () => {
    expect(bearerMatches(`Bearer ${key}`, key)).toBe(true);
    expect(bearerMatches(`Bearer ${key}x`, key)).toBe(false);
    expect(bearerMatches(`bearer ${key}`, key)).toBe(false);
    expect(bearerMatches(key, key)).toBe(false);
    expect(bearerMatches(undefined, key)).toBe(false);
  });
  it("refuses everything when no (or a trivially short) key is configured", () => {
    expect(bearerMatches("Bearer abc", undefined)).toBe(false);
    expect(bearerMatches("Bearer abc", "abc")).toBe(false);
    expect(bearerMatches("Bearer ", "")).toBe(false);
  });
});

describe("e6ToUsd", () => {
  it("converts exactly on the e6 grid, including sub-cent memecoin prices", () => {
    expect(e6ToUsd("3461")).toBe(0.003461);
    expect(e6ToUsd("1")).toBe(0.000001);
    expect(e6ToUsd("226870")).toBe(0.22687);
    expect(e6ToUsd("12345678901234")).toBe(12345678.901234);
  });
});

describe("parseIngestBody", () => {
  it("accepts a well-formed body", () => {
    const r = parseIngestBody(body([tick(), tick({ oracleE6: null })]), NOW);
    expect(r).toMatchObject({ ok: true, rejected: 0 });
    if (r.ok) expect(r.ticks).toHaveLength(2);
  });
  it("fails the whole request on a structural problem", () => {
    expect(parseIngestBody(null, NOW)).toMatchObject({ ok: false });
    expect(parseIngestBody(body([], { v: 2 }), NOW)).toMatchObject({ ok: false });
    expect(parseIngestBody({ v: 1, ticks: "x" }, NOW)).toMatchObject({ ok: false });
    expect(parseIngestBody(body(Array.from({ length: 201 }, () => tick())), NOW)).toMatchObject({ ok: false });
  });
  it("drops only the bad ticks", () => {
    const r = parseIngestBody(
      body([
        tick(),
        tick({ slab: "nope" }),
        tick({ markE6: "0" }),
        tick({ markE6: "-5" }),
        tick({ markE6: "1.5" }),
        tick({ markE6: 5 }),
        tick({ oracleE6: "abc" }),
        tick({ slot: -1 }),
        tick({ landedMs: NOW + MAX_FUTURE_SKEW_MS + 1 }),
        tick({ landedMs: NOW - MAX_AGE_MS - 1 }),
      ]),
      NOW,
    );
    expect(r).toMatchObject({ ok: true, rejected: 9 });
    if (r.ok) expect(r.ticks).toHaveLength(1);
  });
});
