// @vitest-environment node
/**
 * Client-IP trust (same flaw as percolator-indexer #291). The caller controls the left of
 * X-Forwarded-For and the whole of X-Real-IP, so:
 *  - an XFF chain shorter than TRUSTED_PROXY_DEPTH must NOT be clamped to a caller-written hop;
 *  - x-real-ip must never be read;
 *  - anything else collapses to ONE shared "unknown-ip" key (fail closed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const FAIL_CLOSED = "unknown-ip";
const REAL = "203.0.113.7";
const SPOOF = "198.51.100.66";

function req(xff: string | null, realIp?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (xff !== null) headers["x-forwarded-for"] = xff;
  if (realIp !== undefined) headers["x-real-ip"] = realIp;
  return new NextRequest("http://localhost/api/x", { headers });
}

let saved: string | undefined;
beforeEach(() => { saved = process.env.TRUSTED_PROXY_DEPTH; vi.resetModules(); });
afterEach(() => {
  if (saved === undefined) delete process.env.TRUSTED_PROXY_DEPTH; else process.env.TRUSTED_PROXY_DEPTH = saved;
  vi.restoreAllMocks();
});

async function ip(depth: string | undefined, xff: string | null, realIp?: string) {
  if (depth === undefined) delete process.env.TRUSTED_PROXY_DEPTH; else process.env.TRUSTED_PROXY_DEPTH = depth;
  const { getClientIp } = await import("@/lib/get-client-ip");
  return getClientIp(req(xff, realIp));
}

describe("getClientIp fails closed", () => {
  it("depth 2 with a one-hop chain does not clamp to the caller's hop", async () => {
    expect(await ip("2", SPOOF)).toBe(FAIL_CLOSED);
  });

  it("rotating a short chain never yields a fresh key", async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) keys.add(await ip("3", `10.1.1.${i}, 10.2.2.${i}`));
    expect([...keys]).toEqual([FAIL_CLOSED]);
  });

  it("rotating x-real-ip never yields a fresh key (with and without XFF)", async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 20; i++) {
      keys.add(await ip(undefined, null, `10.3.3.${i}`));
      keys.add(await ip(undefined, "not-an-ip", `10.4.4.${i}`));
    }
    expect([...keys]).toEqual([FAIL_CLOSED]);
  });

  it("a non-IP hop falls to the shared key, not x-real-ip", async () => {
    expect(await ip("1", `${SPOOF}, garbage`, SPOOF)).toBe(FAIL_CLOSED);
    expect(await ip("1", "", SPOOF)).toBe(FAIL_CLOSED);
  });

  it("x-real-ip is ignored even when the chain is valid", async () => {
    expect(await ip("1", `${SPOOF}, ${REAL}`, SPOOF)).toBe(REAL);
  });

  it("depth 0 trusts nothing", async () => {
    expect(await ip("0", `${SPOOF}, ${REAL}`, SPOOF)).toBe(FAIL_CLOSED);
  });

  it("a chain exactly as long as the depth trusts its leftmost hop; longer chains peel from the right", async () => {
    expect(await ip("2", `${REAL}, 10.0.0.9`)).toBe(REAL);
    expect(await ip("1", REAL)).toBe(REAL);
    expect(await ip("2", `${SPOOF}, ${REAL}, 10.0.0.9`)).toBe(REAL);
  });
});
