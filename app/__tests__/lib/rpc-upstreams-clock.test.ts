// @vitest-environment node
/** UpstreamPool cooldown bookkeeping under a stepped-back wall clock, stale fail counts, and heavy reads. Injected `now`, no network. */
import { describe, expect, it } from "vitest";
import { UpstreamPool, UpstreamUnavailableError, buildUpstreams } from "@/lib/rpc-upstreams";

const P = "https://devnet.primary-rpc.test/v1/?api-key=PRIMARYKEY-0123456789";
const ups = buildUpstreams("devnet", { url: P, headers: {} }, { DEVNET_RPC_FALLBACK_URLS: "" } as unknown as NodeJS.ProcessEnv);
const REQ = { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] };
const HEAVY = { jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] };

const BASE = 30_000;
const MAX = 300_000;

function mkPool(clock: { t: number }, fail: { on: boolean }) {
  const fetchImpl = (async () => {
    if (fail.on) throw new Error("timeout");
    return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: 1 }) } as Response;
  }) as unknown as typeof fetch;
  return new UpstreamPool({ fetchImpl, now: () => clock.t, cooldownBaseMs: BASE, cooldownMaxMs: MAX, warn: () => {} });
}
const tryOnce = (p: UpstreamPool, body: unknown = REQ) => p.post(ups, body, "devnet").then(() => true, (e) => { if (!(e instanceof UpstreamUnavailableError)) throw e; return false; });

describe("clock stepped backwards", () => {
  it("a first ambiguous strike followed by a backward step is still just one strike", async () => {
    const clock = { t: 1_000_000 };
    const fail = { on: true };
    const p = mkPool(clock, fail);
    await tryOnce(p);
    expect(p.isCooling(ups[0]!)).toBe(false);
    clock.t -= 5_000; // NTP step back
    await tryOnce(p);
    expect(p.isCooling(ups[0]!)).toBe(false); // second strike is a stale-gap one, not within the window
  });

  it("a cooldown set before a backward step never outlasts the max cooldown", async () => {
    const clock = { t: 1_000_000 };
    const fail = { on: true };
    const p = mkPool(clock, fail);
    for (let i = 0; i < 10; i++) {
      await tryOnce(p);
      await tryOnce(p);
    }
    expect(p.isCooling(ups[0]!)).toBe(true);
    clock.t -= 3_600_000; // clock steps back one hour
    expect(p.isCooling(ups[0]!)).toBe(true);
    clock.t += MAX; // MAX after the step is enough
    expect(p.isCooling(ups[0]!)).toBe(false);
  });
});

describe("cooldown escalation decay", () => {
  it("a failure long after the last one starts again from the base cooldown", async () => {
    const clock = { t: 1_000_000 };
    const fail = { on: true };
    const p = mkPool(clock, fail);
    // burst: all cooling, forced attempts each double the cooldown up to max
    for (let i = 0; i < 12; i++) {
      await tryOnce(p);
      await tryOnce(p);
      clock.t += 1;
    }
    clock.t += MAX + 1; // cooldown over
    expect(p.isCooling(ups[0]!)).toBe(false);
    clock.t += 3_600_000; // an hour of the upstream simply not being asked
    await tryOnce(p); // first strike
    await tryOnce(p); // second strike -> cool
    const t0 = clock.t;
    clock.t = t0 + BASE + 1;
    expect(p.isCooling(ups[0]!)).toBe(false); // base cooldown, not max
  });
});

describe("heavy reads", () => {
  it("an always-timing-out heavy read never cools the upstream (by design)", async () => {
    const clock = { t: 1_000_000 };
    const p = mkPool(clock, { on: true });
    for (let i = 0; i < 20; i++) await tryOnce(p, HEAVY);
    expect(p.isCooling(ups[0]!)).toBe(false);
  });
});
