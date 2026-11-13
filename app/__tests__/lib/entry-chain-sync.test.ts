/** r10 owner decision 6: chain-derived entry beats the device cache; an unreadable chain leaves the cache untouched; RPC is bounded. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const h = vi.hoisted(() => ({ entryFromChain: vi.fn(), fee: 30n as bigint | null }));
vi.mock("@/lib/entry-chain", () => ({ entryFromChain: h.entryFromChain }));
vi.mock("@/lib/limits/decode", () => ({ decodeMarketEngineView: () => (h.fee === null ? null : { tradeFeeBaseBps: h.fee }) }));

import { COOLDOWN_MS, __resetEntryChainSyncForTests, holdChainSync, rebuildDue, shouldSyncPosition, syncChainEntry } from "@/lib/entry-chain-sync";
import { clearEntryPrice, getSavedEntry, markEntryUnknown, saveEntryPrice } from "@/lib/entry-price";

const SLAB = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const portfolio = Keypair.generate().publicKey;
const wrapper = Keypair.generate().publicKey;
const T = 1_000_000n;
const conn = { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })) } as never;
const target = (qNow = 2n * T) => ({ slab: SLAB, idx: 0, wallet: WALLET, portfolio, wrapper, qNow });
const chain = (entry: bigint | null = 101_000_000n) => ({
  verdict: "chain" as const,
  txRead: 3,
  entry: { entryPriceE6: entry, bookedPriceE6: 100_500_000n, busyFeeAtoms: 7n, sizeQ: 2n * T, fills: 2 },
});

beforeEach(() => {
  localStorage.clear();
  __resetEntryChainSyncForTests();
  h.entryFromChain.mockReset();
  h.fee = 30n;
});

describe("syncChainEntry", () => {
  it("another browser (no record): the chain entry is saved under the key every surface reads, with its basis and busy fee", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    expect(await syncChainEntry(conn, target())).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ entryPriceE6: 101_000_000n, bookedPriceE6: 100_500_000n, busyFeeAtoms: 7n, sizeQ: 2n * T });
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    expect(h.entryFromChain.mock.calls[0][2]).toMatchObject({ qNow: 2n * T, baseFeeBps: 30n });
  });
  it("chain beats a STALE device record (a partial close made elsewhere left a record for another size)", async () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 3, WALLET, 5n * T);
    h.entryFromChain.mockResolvedValue(chain());
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(101_000_000n);
    expect(getSavedEntry(SLAB, 0, WALLET)?.leverage).toBe(3); // the order leverage the device knew is kept
  });
  it("NEGATIVE: the chain could not be read completely: the device cache is left exactly as it was", async () => {
    saveEntryPrice(SLAB, 0, 90_000_000n, 3, WALLET, 5n * T);
    for (const verdict of ["unreadable", "incomplete", "mismatch", "unexplained"] as const) {
      __resetEntryChainSyncForTests();
      localStorage.removeItem(`perc:entrychain:v1:${portfolio.toBase58()}`);
      h.entryFromChain.mockResolvedValue({ verdict, entry: null, txRead: 1 });
      expect(await syncChainEntry(conn, target())).toBe(verdict);
      expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ entryPriceE6: 90_000_000n, sizeQ: 5n * T });
    }
  });
  it("NEGATIVE: read fully but the price of a fill cannot be split from its fee: nothing is written", async () => {
    h.entryFromChain.mockResolvedValue(chain(null));
    expect(await syncChainEntry(conn, target())).toBe("unexplained");
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
  it("NEGATIVE: the market's base fee cannot be read: nothing is guessed (no chain read at all)", async () => {
    h.fee = null;
    expect(await syncChainEntry(conn, target())).toBe("unreadable");
    expect(h.entryFromChain).not.toHaveBeenCalled();
  });
  it("bounded: a done rebuild is not repeated for that size, an unreadable one waits for the cooldown, concurrent callers share one run", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    const [a, b] = await Promise.all([syncChainEntry(conn, target()), syncChainEntry(conn, target())]);
    expect([a, b]).toEqual(["chain", "chain"]);
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    // a different size (a trade since) is due again
    h.entryFromChain.mockResolvedValue({ verdict: "unreadable", entry: null, txRead: 0 });
    expect(await syncChainEntry(conn, target(3n * T))).toBe("unreadable");
    expect(await syncChainEntry(conn, target(3n * T))).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(2);
  });
  it("the attempt survives a reload (storage), so a page refresh does not retry an unreadable chain at once", async () => {
    h.entryFromChain.mockResolvedValue({ verdict: "incomplete", entry: null, txRead: 60 });
    await syncChainEntry(conn, target());
    __resetEntryChainSyncForTests(); // memory gone, storage stays
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
  });
  it("a flat position never reads the chain", async () => {
    expect(await syncChainEntry(conn, target(0n))).toBe("skipped");
    expect(h.entryFromChain).not.toHaveBeenCalled();
  });
});

describe("rebuildDue", () => {
  const at = (verdict: "chain" | "unreadable" | "incomplete", q: bigint, ts: number) => ({ q: q.toString(), verdict, ts });
  it("due with no attempt or another size; a finished one never repeats; a failed one only after the cooldown", () => {
    expect(rebuildDue(null, T, 0)).toBe(true);
    expect(rebuildDue(at("chain", T, 0), 2n * T, 1)).toBe(true);
    expect(rebuildDue(at("chain", T, 0), T, 10 * COOLDOWN_MS)).toBe(false);
    expect(rebuildDue(at("incomplete", T, 0), T, COOLDOWN_MS - 1)).toBe(false);
    expect(rebuildDue(at("unreadable", T, 0), T, COOLDOWN_MS)).toBe(true);
  });
});

describe("owner decision 2: the r9 'unknown' is never filled in", () => {
  it("a ticket-unknown position (marker) is skipped: no chain read, nothing written, even after the ticket's clearEntryPrice calls", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    markEntryUnknown(SLAB, 0, WALLET);
    clearEntryPrice(SLAB, 0, WALLET); // a later add / reduce on the position clears the record, not the marker
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).not.toHaveBeenCalled();
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
  it("a real measured save replaces the marker (the next trade's own entry), so later rebuilds are possible again", () => {
    markEntryUnknown(SLAB, 0, WALLET);
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, T);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("a marker (or a record) written while the chain was being read wins: the chain never overwrites it", async () => {
    h.entryFromChain.mockImplementation(async () => {
      markEntryUnknown(SLAB, 0, WALLET); // the ticket marks unknown mid-read
      return chain();
    });
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
    __resetEntryChainSyncForTests();
    localStorage.clear();
    h.entryFromChain.mockImplementation(async () => {
      saveEntryPrice(SLAB, 0, 95_000_000n, 2, WALLET, 2n * T); // the ticket's own measured save lands mid-read
      return chain();
    });
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(95_000_000n);
  });
});

describe("a trade in flight on the market holds the rebuild", () => {
  it("held: skipped without any read; after the hold it runs", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    holdChainSync(SLAB, 60_000);
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).not.toHaveBeenCalled();
    holdChainSync(SLAB, -1_000_000, 0); // (no effect: holds only extend)
    __resetEntryChainSyncForTests();
    expect(await syncChainEntry(conn, target())).toBe("chain");
  });
  it("a hold taken while the rebuild was reading stops it from saving", async () => {
    h.entryFromChain.mockImplementation(async () => {
      holdChainSync(SLAB, 60_000);
      return chain();
    });
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
});

describe("usePortfolio trigger (shouldSyncPosition)", () => {
  const row = (o: Record<string, unknown> = {}) => ({
    slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: 2n * T, nftWrapped: false, portfolioPk: portfolio,
    entryPriceSource: "unknown", account: { positionSize: 2n * T }, ...o,
  });
  it("an open, readable, self-owned position with no current entry qualifies (unknown or estimated source)", () => {
    expect(shouldSyncPosition(row(), WALLET)).toBe(true);
    expect(shouldSyncPosition(row({ entryPriceSource: "derived" }), WALLET)).toBe(true);
  });
  it.each([
    ["a current device entry (cache)", { entryPriceSource: "cache" }],
    ["a server entry", { entryPriceSource: "server" }],
    ["an NFT-wrapped position", { nftWrapped: true }],
    ["an unreadable ADL state", { adlKnown: false }],
    ["a flat position", { account: { positionSize: 0n } }],
    ["a zero effective size", { effectiveSize: 0n }],
    ["no portfolio account", { portfolioPk: null }],
  ])("not for %s", (_n, o) => {
    expect(shouldSyncPosition(row(o), WALLET)).toBe(false);
  });
  it("not for the ticket's explicit unknown, nor with a trade in flight on the market", () => {
    markEntryUnknown(SLAB, 0, WALLET);
    expect(shouldSyncPosition(row(), WALLET)).toBe(false);
    localStorage.clear();
    holdChainSync(SLAB, 60_000);
    expect(shouldSyncPosition(row(), WALLET)).toBe(false);
  });
});
