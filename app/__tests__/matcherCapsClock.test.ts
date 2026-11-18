/**
 * Clock-step regression: a negative cache age (wall clock stepped back, or an entry written
 * while the clock was ahead) must count as STALE for both the ctx-address and caps caches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";

const resolveMarketLp = vi.fn();
vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: (...a: unknown[]) => resolveMarketLp(...a) }));

import { getMatcherCaps, invalidateMatcherCaps } from "@/lib/matcherCaps";

function ctxData(maxFill: bigint): Buffer {
  const buf = Buffer.alloc(320);
  buf.writeBigUInt64LE(maxFill, 64 + 80);
  buf.writeBigUInt64LE(1000n, 64 + 128);
  return buf;
}

describe("matcherCaps cache clock steps", () => {
  const program = Keypair.generate().publicKey;
  const slab = Keypair.generate().publicKey;
  const ctx = Keypair.generate().publicKey;
  const lp = Keypair.generate().publicKey;
  let fill = 100n;
  const connection = {
    getAccountInfo: vi.fn(async () => ({ data: ctxData(fill) })),
  } as never;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    fill = 100n;
    resolveMarketLp.mockReset();
    resolveMarketLp.mockResolvedValue({ matcherCtx: ctx, pubkey: lp });
    invalidateMatcherCaps(program, slab);
  });
  afterEach(() => vi.useRealTimers());

  it("serves a fresh entry within the TTL", async () => {
    expect((await getMatcherCaps(connection, program, slab))?.maxFillAbs).toBe(100n);
    fill = 200n;
    vi.setSystemTime(Date.now() + 60_000);
    expect((await getMatcherCaps(connection, program, slab))?.maxFillAbs).toBe(100n);
  });

  it("re-reads caps and ctx address after the clock steps backwards", async () => {
    await getMatcherCaps(connection, program, slab);
    expect(resolveMarketLp).toHaveBeenCalledTimes(1);
    fill = 200n;
    vi.setSystemTime(Date.now() - 3_600_000); // negative age
    expect((await getMatcherCaps(connection, program, slab))?.maxFillAbs).toBe(200n);
    expect(resolveMarketLp).toHaveBeenCalledTimes(2);
  });
});
