/**
 * Differential test for the matcherCaps key memo: a randomized sequence of slabs (including
 * fresh PublicKey objects for the same address), TTL expiries and invalidations must return the
 * same ctx/caps and trigger the same number of RPC re-reads as a reference model that keys every
 * call by a freshly encoded `programId|slab` string (the pre-memo behaviour).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const resolveMarketLp = vi.fn();
vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: (...a: unknown[]) => resolveMarketLp(...a) }));

import { getMatcherCaps, getMatcherInventory, invalidateMatcherCaps } from "@/lib/matcherCaps";

const TTL = 300_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("matcherCaps key memo differential", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    resolveMarketLp.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("matches the reference model over a random op sequence", async () => {
    const rand = rng(42);
    const program = Keypair.generate().publicKey;
    const slabs = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
    const clone = (pk: PublicKey) => new PublicKey(pk.toBase58());
    const gen: Record<string, number> = {};
    const fill: Record<string, bigint> = {};
    for (const s of slabs) {
      gen[s.toBase58()] = 0;
      fill[s.toBase58()] = 100n;
    }
    // Each LP resolution mints a new ctx so a stale/missed cache is observable.
    const ctxOf = new Map<string, PublicKey>();
    resolveMarketLp.mockImplementation(async (_c: unknown, _p: unknown, slab: PublicKey) => {
      const k = slab.toBase58();
      gen[k]++;
      const ctx = Keypair.generate().publicKey;
      ctxOf.set(k, ctx);
      return { matcherCtx: ctx, pubkey: Keypair.generate().publicKey };
    });
    const connection = {
      getAccountInfo: async (ctx: PublicKey) => {
        const k = [...ctxOf.entries()].find(([, v]) => v.equals(ctx))?.[0] as string;
        const buf = Buffer.alloc(320);
        buf.writeBigUInt64LE(fill[k], 64 + 80);
        buf.writeBigUInt64LE(1000n, 64 + 128);
        return { data: buf };
      },
    } as never;

    // Reference model: ctx-address cache and caps cache, string keys encoded fresh each call.
    const refCtx = new Map<string, { n: number; ts: number }>();
    const refCaps = new Map<string, { fill: bigint; ts: number }>();
    let refResolves = 0;

    for (let i = 0; i < 400; i++) {
      const slab = slabs[Math.floor(rand() * slabs.length)];
      const useSlab = rand() < 0.5 ? slab : clone(slab);
      const useProg = rand() < 0.5 ? program : clone(program);
      const key = `${program.toBase58()}|${slab.toBase58()}`;
      const op = rand();
      if (op < 0.15) {
        vi.setSystemTime(Date.now() + Math.floor(rand() * TTL * 1.5));
      } else if (op < 0.25) {
        invalidateMatcherCaps(useProg, useSlab);
        refCtx.delete(key);
        refCaps.delete(key);
      } else if (op < 0.3) {
        fill[slab.toBase58()] = BigInt(100 + Math.floor(rand() * 900));
      } else if (op < 0.65) {
        const now = Date.now();
        const got = await getMatcherCaps(connection, useProg, useSlab);
        let c = refCaps.get(key);
        if (!(c && now - c.ts >= 0 && now - c.ts < TTL)) {
          let a = refCtx.get(key);
          if (!(a && now - a.ts >= 0 && now - a.ts < TTL)) {
            refResolves++;
            a = { n: refResolves, ts: now };
            refCtx.set(key, a);
          }
          c = { fill: fill[slab.toBase58()], ts: now };
          refCaps.set(key, c);
        }
        expect(got?.maxFillAbs).toBe(c.fill);
      } else {
        const now = Date.now();
        const got = await getMatcherInventory(connection, useProg, useSlab);
        const a = refCtx.get(key);
        if (!(a && now - a.ts >= 0 && now - a.ts < TTL)) {
          refResolves++;
          refCtx.set(key, { n: refResolves, ts: now });
        }
        expect(got).not.toBeNull();
      }
      const total = Object.values(gen).reduce((x, y) => x + y, 0);
      expect(total).toBe(refResolves);
    }
  });
});
