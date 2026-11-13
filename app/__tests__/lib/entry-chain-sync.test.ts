/** r10 owner decision 6: chain-derived entry beats the device cache; an unreadable chain leaves the cache untouched; RPC is bounded. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const h = vi.hoisted(() => ({ entryFromChain: vi.fn(), fee: 30n as bigint | null, growth: "present" as string, nowQ: null as bigint | null, sigs: [] as string[], sigCalls: 0, resolveArgs: [] as { matcherCtxData: Uint8Array | null; assetIndex?: number }[] }));
vi.mock("@/lib/v21/growth-market", () => ({ growthRecordPresence: () => h.growth }));
vi.mock("@/lib/limits/trade-fee-resolve", () => ({ resolveTradeFeeBps: (a: { matcherCtxData: Uint8Array | null; assetIndex?: number }) => { h.resolveArgs.push(a); return { feeBps: 135n, maxFeeBps: 700n }; } }));
vi.mock("@/lib/position-change", () => ({ readEffectivePositionQ: async () => h.nowQ }));
vi.mock("@/lib/entry-chain", () => ({ entryFromChain: h.entryFromChain }));
vi.mock("@/lib/limits/decode", () => ({ decodeMarketEngineView: () => (h.fee === null ? null : { tradeFeeBaseBps: h.fee }) }));

import { COOLDOWN_MS, VERIFY_MS, __resetEntryChainSyncForTests, holdChainSync, rebuildDue, shouldSyncPosition, syncChainEntry } from "@/lib/entry-chain-sync";
import { clearEntryPrice, getSavedEntry, markEntryUnknown, markUnpricedFill, saveEntryPrice } from "@/lib/entry-price";

const SLAB = Keypair.generate().publicKey.toBase58();
const WALLET = Keypair.generate().publicKey.toBase58();
const portfolio = Keypair.generate().publicKey;
const wrapper = Keypair.generate().publicKey;
const T = 1_000_000n;
const conn = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })),
  getSignaturesForAddress: vi.fn(async () => {
    h.sigCalls++;
    return h.sigs.map((signature) => ({ signature }));
  }),
} as never;
const target = (qNow = 2n * T) => ({ slab: SLAB, idx: 0, wallet: WALLET, portfolio, wrapper, qNow });
const chain = (entry: bigint | null = 101_000_000n, topSig = "sigA") => ({
  verdict: "chain" as const,
  txRead: 3,
  topSig,
  entry: { entryPriceE6: entry, bookedPriceE6: 100_500_000n, busyFeeAtoms: 7n, sizeQ: 2n * T, fills: 2 },
});

beforeEach(() => {
  localStorage.clear();
  __resetEntryChainSyncForTests();
  h.entryFromChain.mockReset();
  h.fee = 30n;
  h.growth = "present";
  h.nowQ = 2n * T; // the chain still holds the size the rebuild was for
  h.sigs = [];
  h.sigCalls = 0;
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
    expect(await syncChainEntry(conn, target())).toBe("skipped"); // within the verify window
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    // a different size (a trade since) is due again
    h.entryFromChain.mockResolvedValue({ verdict: "unreadable", entry: null, txRead: 0 });
    expect(await syncChainEntry(conn, target(3n * T))).toBe("unreadable");
    expect(await syncChainEntry(conn, target(3n * T))).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(3); // chain (1 walk) + unreadable (wallet walk, then the portfolio walk)
  });
  it("the attempt survives a reload (storage), so a page refresh does not retry an unreadable chain at once", async () => {
    h.entryFromChain.mockResolvedValue({ verdict: "incomplete", entry: null, txRead: 60 });
    await syncChainEntry(conn, target());
    __resetEntryChainSyncForTests(); // memory gone, storage stays
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(2);
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
    expect(rebuildDue(at("chain", T, 0), T, VERIFY_MS - 1)).toBe(false); // a chain record is re-verified after VERIFY_MS, never trusted by size alone
    expect(rebuildDue(at("chain", T, 0), T, VERIFY_MS)).toBe(true);
    expect(rebuildDue(at("incomplete", T, 0), T, COOLDOWN_MS - 1)).toBe(false);
    expect(rebuildDue(at("unreadable", T, 0), T, COOLDOWN_MS)).toBe(true);
  });
});

describe("owner decision 2: the r9 'unknown' is never filled in", () => {
  it("a ticket-unknown position (marker) is skipped: no chain read, nothing written, even after the ticket's clearEntryPrice calls", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    clearEntryPrice(SLAB, 0, WALLET); // a later add / reduce on the position clears the record, not the marker
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).not.toHaveBeenCalled();
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
  it("a real measured save replaces the marker (the next trade's own entry), so later rebuilds are possible again", () => {
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, T);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("a marker (or a record) written while the chain was being read wins: the chain never overwrites it", async () => {
    h.entryFromChain.mockImplementation(async () => {
      markEntryUnknown(SLAB, 0, WALLET, 2n * T); // the ticket marks unknown mid-read
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
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    expect(shouldSyncPosition(row(), WALLET)).toBe(false);
    localStorage.clear();
    holdChainSync(SLAB, 60_000);
    expect(shouldSyncPosition(row(), WALLET)).toBe(false);
  });
});

describe("N2: the unknown marker is tied to the position", () => {
  it("honoured only at the size it was written for; a different size retires it", () => {
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    expect(shouldSyncPosition({ slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: 2n * T, portfolioPk: portfolio, entryPriceSource: "unknown", account: { positionSize: 2n * T } }, WALLET)).toBe(false);
    expect(shouldSyncPosition({ slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: 3n * T, portfolioPk: portfolio, entryPriceSource: "unknown", account: { positionSize: 3n * T } }, WALLET)).toBe(true);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("a close to flat clears it (a reopen elsewhere can then be rebuilt); a plain clear (reduce / add) does not", () => {
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    clearEntryPrice(SLAB, 0, WALLET);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).not.toBeNull();
    clearEntryPrice(SLAB, 0, WALLET, { flat: true });
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("end to end: unknown, close to flat, reopen at the same size elsewhere: the rebuild is allowed", async () => {
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    clearEntryPrice(SLAB, 0, WALLET, { flat: true });
    h.entryFromChain.mockResolvedValue(chain());
    expect(await syncChainEntry(conn, target())).toBe("chain");
  });
});

describe("N3: a chain record is vouched for by the portfolio's newest signature", () => {
  it("a same-size close + reopen (a newer signature) rebuilds; the same newest signature only re-checks", async () => {
    let t = 1_000_000;
    h.entryFromChain.mockResolvedValue(chain(101_000_000n, "sigA"));
    expect(await syncChainEntry(conn, target(), () => t)).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)?.chainSig).toBe("sigA");
    // a minute later the newest signature is unchanged: one cheap read, no rebuild
    t += VERIFY_MS;
    h.sigs = ["sigA"];
    await syncChainEntry(conn, target(), () => t);
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    expect(h.sigCalls).toBe(1);
    // the position was closed and reopened at the SAME size at another price: a newer signature
    t += VERIFY_MS;
    h.sigs = ["sigB"];
    h.entryFromChain.mockResolvedValue(chain(95_000_000n, "sigB"));
    await syncChainEntry(conn, target(), () => t);
    expect(h.entryFromChain).toHaveBeenCalledTimes(2);
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ entryPriceE6: 95_000_000n, chainSig: "sigB" });
  });
  it("a newer signature after which the chain cannot vouch (unexplained) removes the stale chain record; an unreadable chain keeps it", async () => {
    let t = 1_000_000;
    h.entryFromChain.mockResolvedValue(chain(101_000_000n, "sigA"));
    await syncChainEntry(conn, target(), () => t);
    t += VERIFY_MS;
    h.sigs = ["sigB"];
    h.entryFromChain.mockResolvedValue({ verdict: "unreadable", entry: null, txRead: 0 });
    await syncChainEntry(conn, target(), () => t);
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(101_000_000n);
    t += COOLDOWN_MS;
    h.entryFromChain.mockResolvedValue({ verdict: "unexplained", entry: null, txRead: 5 });
    await syncChainEntry(conn, target(), () => t);
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
  it("trigger: a chain-sourced record (chainSig) is a candidate to re-verify; a device-written one is not", async () => {
    const row = { slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: 2n * T, portfolioPk: portfolio, entryPriceSource: "cache", account: { positionSize: 2n * T } };
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 2n * T);
    expect(shouldSyncPosition(row, WALLET)).toBe(false);
    saveEntryPrice(SLAB, 0, 100_000_000n, 2, WALLET, 2n * T, { chainSig: "sigA" });
    expect(shouldSyncPosition(row, WALLET)).toBe(true);
  });
});

describe("N4: a rebuild for an old size never saves", () => {
  it("the chain size moved while the walk ran: nothing is written", async () => {
    h.entryFromChain.mockResolvedValue(chain());
    h.nowQ = 3n * T; // a trade landed during the read
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
  });
});

describe("N5: the growth status comes from the market's growth record", () => {
  it("a growth record -> mayChargeBusy true; none ('absent') -> false (not hard-coded)", async () => {
    h.entryFromChain.mockResolvedValue({ verdict: "incomplete", entry: null, txRead: 1 });
    h.growth = "present";
    await syncChainEntry(conn, target());
    expect(h.entryFromChain.mock.calls.at(-1)?.[2].mayChargeBusy).toBe(true);
    __resetEntryChainSyncForTests();
    localStorage.clear();
    h.growth = "absent";
    await syncChainEntry(conn, target());
    expect(h.entryFromChain.mock.calls.at(-1)?.[2].mayChargeBusy).toBe(false);
    __resetEntryChainSyncForTests();
    localStorage.clear();
    h.growth = "undecodable";
    await syncChainEntry(conn, target());
    expect(h.entryFromChain.mock.calls.at(-1)?.[2].mayChargeBusy).toBe(true); // fails toward the stricter rule
  });
});

describe("D1: the no-busy cap the chain compares with", () => {
  it("is the market's own cap (resolveTradeFeeBps with no busy rate) and is handed to the walk", async () => {
    h.entryFromChain.mockResolvedValue({ verdict: "incomplete", entry: null, txRead: 1 });
    await syncChainEntry(conn, target());
    const o = h.entryFromChain.mock.calls[0][2];
    expect(await o.noBusyCap(null)).toEqual({ feeBps: 135n, maxFeeBps: 700n });
    // E4(a): the matcher context the instruction named is read and handed to the cap (it can lower the worst-case matcher fee)
    h.resolveArgs.length = 0;
    await o.noBusyCap(Keypair.generate().publicKey);
    expect(h.resolveArgs.at(-1)?.matcherCtxData).not.toBeNull();
    expect(h.resolveArgs.at(-1)?.assetIndex).toBe(0);
  });
});

describe("D3: a marker with a fill signature is retired when its position is gone", () => {
  const withSig = (sig: string) => markEntryUnknown(SLAB, 0, WALLET, 2n * T, sig);
  it("the walk shows the marked fill is not part of the current position (closed + reopened elsewhere at the same size): marker retired, chain Entry saved", async () => {
    withSig("oldFill");
    h.entryFromChain.mockResolvedValue({ ...chain(), positionSigs: ["newOpen"] });
    expect(await syncChainEntry(conn, target())).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(101_000_000n);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("the marked fill IS part of the current position: the marker stands, nothing is saved, and the probe waits for the cooldown", async () => {
    withSig("theFill");
    h.entryFromChain.mockResolvedValue({ ...chain(), positionSigs: ["theFill"] });
    await syncChainEntry(conn, target());
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).not.toBeNull();
    expect(await syncChainEntry(conn, target())).toBe("skipped");
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
  });
  it("a walk that did not reach the start proves nothing: the marker stands", async () => {
    withSig("oldFill");
    h.entryFromChain.mockResolvedValue({ verdict: "incomplete", entry: null, txRead: 60 });
    await syncChainEntry(conn, target());
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).not.toBeNull();
  });
  it("trigger: a marker with a signature is probed, one without is not", () => {
    const row = { slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: 2n * T, portfolioPk: portfolio, entryPriceSource: "unknown", account: { positionSize: 2n * T } };
    markEntryUnknown(SLAB, 0, WALLET, 2n * T);
    expect(shouldSyncPosition(row, WALLET)).toBe(false);
    markEntryUnknown(SLAB, 0, WALLET, 2n * T, "fillSig");
    expect(shouldSyncPosition(row, WALLET)).toBe(true);
  });
});

describe("D4", () => {
  it("(d) markUnpricedFill: an open or add marks; a reduce, a close and a flat-to-flat do not", () => {
    expect(markUnpricedFill(SLAB, 0, WALLET, "s", 0n, 2n * T)).toBe(true);
    localStorage.clear();
    expect(markUnpricedFill(SLAB, 0, WALLET, "s", 2n * T, 3n * T)).toBe(true);
    localStorage.clear();
    expect(markUnpricedFill(SLAB, 0, WALLET, "s", 3n * T, 2n * T)).toBe(false);
    expect(markUnpricedFill(SLAB, 0, WALLET, "s", 2n * T, 0n)).toBe(false);
    expect(localStorage.getItem(`perc:entry-unknown:${SLAB}:0:${WALLET}`)).toBeNull();
  });
  it("(c) a verify read that throws backs off a full verify window instead of retrying every poll", async () => {
    let t = 1_000_000;
    h.entryFromChain.mockResolvedValue(chain(101_000_000n, "sigA"));
    await syncChainEntry(conn, target(), () => t);
    t += VERIFY_MS;
    (conn as unknown as { getSignaturesForAddress: ReturnType<typeof vi.fn> }).getSignaturesForAddress.mockRejectedValueOnce(new Error("429"));
    await syncChainEntry(conn, target(), () => t);
    const before = h.sigCalls;
    await syncChainEntry(conn, target(), () => t + 1_000);
    expect(h.sigCalls).toBe(before); // not retried within the window
  });
});

describe("E2: the trader's wallet is walked first (cranks flood the portfolio's own list)", () => {
  it("a wallet walk that settles is the only walk; its newest signature vouches for the record (re-checked on the WALLET)", async () => {
    let t = 1_000_000;
    h.entryFromChain.mockResolvedValue(chain(101_000_000n, "walletTop"));
    expect(await syncChainEntry(conn, target(), () => t)).toBe("chain");
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
    expect(h.entryFromChain.mock.calls[0][2].walkAddress.toBase58()).toBe(WALLET);
    t += VERIFY_MS;
    h.sigs = ["walletTop"];
    const calls = (conn as unknown as { getSignaturesForAddress: ReturnType<typeof vi.fn> }).getSignaturesForAddress;
    calls.mockClear();
    await syncChainEntry(conn, target(), () => t);
    expect(calls.mock.calls[0][0].toBase58()).toBe(WALLET); // not the portfolio: crank transactions would change its newest signature every minute
    expect(h.entryFromChain).toHaveBeenCalledTimes(1);
  });
  it("a wallet walk that cannot settle (e.g. a keeper-signed liquidation is not on its list) falls back to the portfolio walk, which decides", async () => {
    h.entryFromChain
      .mockResolvedValueOnce({ verdict: "mismatch", entry: null, txRead: 4 })
      .mockResolvedValueOnce(chain(99_000_000n, "pfTop"));
    expect(await syncChainEntry(conn, target())).toBe("chain");
    expect(h.entryFromChain).toHaveBeenCalledTimes(2);
    expect(h.entryFromChain.mock.calls[0][2].walkAddress).toBeDefined();
    expect(h.entryFromChain.mock.calls[1][2].walkAddress).toBeUndefined();
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(99_000_000n);
  });
});
