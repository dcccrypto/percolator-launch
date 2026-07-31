/**
 * Cache semantics of lib/matcherCaps.ts — the audit finding this pins:
 * SetMatcherConfig (tag 68) can re-point or disable a market's matcher
 * context at ANY time, so a forever-cache left closes chunked by a dead cap
 * for the rest of the session (every over-cap close reverting identically).
 * The contract is: TTL-bounded staleness + immediate failure-driven
 * invalidation. These tests drive the REAL getMatcherCaps against a fake
 * Connection that counts RPC calls — a regression back to a forever-cache,
 * or an invalidation that stops clearing, fails here.
 *
 * Also pins DataView reads working on a Buffer VIEW with nonzero byteOffset —
 * the exact shape web3.js hands back in the browser, where the old
 * Buffer.readBigUInt64LE calls threw and were swallowed into "no caps",
 * silently disabling the whole safety layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  getMatcherCaps,
  getMatcherInventory,
  invalidateMatcherCaps,
  parseMatcherCaps,
  parseMatcherInventory,
} from "@/lib/matcherCaps";

const PROGRAM = Keypair.generate().publicKey;

/** A v17-shaped LP portfolio: magic at 0, enabled matcher config at the tail. */
function makeLpPortfolio(matcherCtx: PublicKey): Buffer {
  const buf = Buffer.alloc(9347);
  Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]).copy(buf, 0);
  const off = buf.length - 104;
  matcherCtx.toBuffer().copy(buf, off + 32); // matcher_context
  buf.writeBigUInt64LE(1n, off + 96); // enabled = 1
  return buf;
}

/** A vAMM matcher context with the given caps + inventory. */
function makeCtx(maxFill: bigint, maxInv: bigint, inventory: bigint): Buffer {
  const buf = Buffer.alloc(64 + 256);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setBigUint64(64 + 80, maxFill & 0xffffffffffffffffn, true);
  dv.setBigUint64(64 + 128, maxInv & 0xffffffffffffffffn, true);
  const u = inventory < 0n ? inventory + (1n << 128n) : inventory;
  dv.setBigUint64(64 + 96, u & 0xffffffffffffffffn, true);
  dv.setBigUint64(64 + 96 + 8, u >> 64n, true);
  return buf;
}

function makeConn(ctxPk: PublicKey, lpData: Buffer, ctxData: Buffer) {
  const counters = { scans: 0, ctxReads: 0 };
  const conn = {
    rpcEndpoint: "https://fake",
    getProgramAccounts: async () => {
      counters.scans++;
      return [{ pubkey: Keypair.generate().publicKey, account: { data: lpData } }];
    },
    getAccountInfo: async (pk: PublicKey) => {
      if (pk.equals(ctxPk)) {
        counters.ctxReads++;
        return { data: ctxData };
      }
      return null;
    },
  } as unknown as Connection;
  return { conn, counters };
}

describe("getMatcherCaps cache TTL + invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches within the TTL, re-resolves after it, and invalidation forces an immediate refetch", async () => {
    const slab = Keypair.generate().publicKey;
    const ctxPk = Keypair.generate().publicKey;
    const { conn, counters } = makeConn(ctxPk, makeLpPortfolio(ctxPk), makeCtx(1000n, 4000n, 0n));

    const first = await getMatcherCaps(conn, PROGRAM, slab);
    expect(first?.maxFillAbs).toBe(1000n);
    expect(counters.scans).toBe(1);

    // Within TTL: served from cache, zero extra RPC.
    await getMatcherCaps(conn, PROGRAM, slab);
    await getMatcherCaps(conn, PROGRAM, slab);
    expect(counters.scans).toBe(1);
    expect(counters.ctxReads).toBe(1);

    // Past the 5-minute TTL: must re-resolve (this is the SetMatcherConfig
    // staleness bound — a forever-cache never re-reads).
    vi.setSystemTime(Date.now() + 301_000);
    await getMatcherCaps(conn, PROGRAM, slab);
    expect(counters.ctxReads).toBe(2);

    // Failure-driven invalidation: immediate refetch, no TTL wait.
    invalidateMatcherCaps(PROGRAM, slab);
    await getMatcherCaps(conn, PROGRAM, slab);
    expect(counters.scans).toBeGreaterThanOrEqual(3);
  });

  it("inventory reads are NEVER cached — every call hits the chain", async () => {
    const slab = Keypair.generate().publicKey;
    const ctxPk = Keypair.generate().publicKey;
    const { conn, counters } = makeConn(ctxPk, makeLpPortfolio(ctxPk), makeCtx(1000n, 4000n, -777n));

    expect(await getMatcherInventory(conn, PROGRAM, slab)).toBe(-777n);
    expect(await getMatcherInventory(conn, PROGRAM, slab)).toBe(-777n);
    expect(await getMatcherInventory(conn, PROGRAM, slab)).toBe(-777n);
    expect(counters.ctxReads).toBe(3);
    // But the ADDRESS resolution was cached — one scan, not three.
    expect(counters.scans).toBe(1);
  });
});

describe("DataView reads survive a Buffer view with nonzero byteOffset", () => {
  // web3.js in the browser hands back Uint8Array views into larger
  // ArrayBuffers. A read that ignores byteOffset (or calls a polyfill-missing
  // Buffer method) reads garbage or throws — and every caller catches to
  // null, so the failure is silent.
  it("parseMatcherCaps + parseMatcherInventory at byteOffset 32", () => {
    const inner = makeCtx(111n, 999n, -42n);
    const outer = Buffer.alloc(inner.length + 64);
    inner.copy(outer, 32);
    const view = outer.subarray(32, 32 + inner.length);
    expect(view.byteOffset).toBe(32);

    const caps = parseMatcherCaps(view);
    expect(caps).not.toBeNull();
    expect(caps!.maxFillAbs).toBe(111n);
    expect(caps!.maxInventoryAbs).toBe(999n);
    expect(parseMatcherInventory(view)).toBe(-42n);
  });
});
