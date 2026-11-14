/**
 * Council r10 round 2 MED (Attacker, Risk): a close and a reopen at exactly the same size on ANOTHER device. The device that held the first
 * position must not keep showing that position's Entry, funding base or average as exact, and a close there must not report a Trade result
 * built from the old book. It must match the new position (rebuilt from chain) or be unknown.
 *
 * Device-written records are matched to the chain by size only before this fix (entry-price.ts entryRecordCurrent, trade-book.ts reconcile,
 * entry-chain-sync.ts shouldSyncPosition / storeChainBook), so every check below used the old position's numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fillEventLogs } from "../helpers/fill-event-fixture";

const h = vi.hoisted(() => ({ nowQ: 0n }));
vi.mock("@/lib/v21/growth-market", () => ({ growthRecordPresence: () => "absent" }));
vi.mock("@/lib/limits/trade-fee-resolve", () => ({ resolveTradeFeeBps: () => ({ feeBps: 135n, maxFeeBps: 700n }) }));
vi.mock("@/lib/position-change", () => ({ readEffectivePositionQ: async () => h.nowQ }));
vi.mock("@/lib/limits/decode", () => ({ decodeMarketEngineView: () => ({ tradeFeeBaseBps: 30n }) }));

import { VERIFY_MS, __resetEntryChainSyncForTests, shouldSyncPosition, syncChainEntry } from "@/lib/entry-chain-sync";
import { getSavedEntry, saveEntryPrice } from "@/lib/entry-price";
import { loadBook, loadBookByWallet, recordFill } from "@/lib/trade-book";
import { MEMO_PROGRAM_ID, fundingMemoIx } from "@/lib/funding-memo";
import { openSinceCheck, prevChangeCheck, prevChangeSig } from "@/lib/entry-chain";
import { prevChangeBeforeFill } from "@/lib/entry-chain-prev";

const WRAPPER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey.toBase58();
const SLAB = MARKET.toBase58();
const PF = PORTFOLIO.toBase58();
const T = 1_000_000n;
const Q = 2n * T;
const W = WRAPPER.toBase58();
const CRANK = [`Program ${W} invoke [1]`, `Program ${W} success`];
const notional = (q: bigint, booked: bigint) => ((q < 0n ? -q : q) * booked) / 1_000_000n;
const fee = (q: bigint, booked: bigint) => (notional(q, booked) * 53n) / 10_000n; // base 30 bp + spread 23 bp
const rec = (q: bigint, booked: bigint) => ({ flags: 8, requestedQ: q, executedQ: q, priceE6: booked, quotedPriceE6: q > 0n ? booked + (booked * 23n) / 10_000n : booked - (booked * 23n) / 10_000n, feeAtoms: fee(q, booked) });
const effective = (booked: bigint) => booked + (booked * 23n) / 10_000n;

const P1 = 80_000_000n; // device 1 opened at 80.00, memo base 400,000
const P2 = 90_000_000n; // device 2 closed P1 and opened the same size at 90.00, memo base 500,000
const BASE1 = 400_000n;
const BASE2 = 500_000n;

const txs: Record<string, { logs: string[]; memo?: bigint }> = {};
let order: string[] = [];
const one = (sig: string) => {
  const t = txs[sig];
  const keys = t.memo !== undefined ? [WRAPPER, MEMO_PROGRAM_ID] : [WRAPPER];
  const ixs = t.memo !== undefined ? [{ programIdIndex: 1, data: new Uint8Array(fundingMemoIx(t.memo).data) }] : [];
  return { slot: 1, meta: { err: null, logMessages: t.logs }, transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } } };
};
const conn = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })),
  getSignaturesForAddress: vi.fn(async (_pk: PublicKey, o: { limit?: number; before?: string; until?: string }) => {
    const start = o.before ? order.indexOf(o.before) + 1 : 0;
    let list = order.slice(start);
    if (o.until) {
      const u = list.indexOf(o.until);
      if (u >= 0) list = list.slice(0, u);
    }
    // the RPC lists an SPL memo's text in `memo` (as "[len] text")
    return list.slice(0, o.limit ?? 1000).map((signature) => ({ signature, slot: 1, err: null, memo: txs[signature]?.memo !== undefined ? `[16] perc:fb1:${txs[signature].memo}` : null, blockTime: 0 }));
  }),
  getTransaction: vi.fn(async (s: string) => one(s)),
  getTransactions: vi.fn(async (s: string[]) => s.map(one)),
} as never;

const fillTx = (q: bigint, booked: bigint, memo?: bigint) => ({ logs: fillEventLogs(WRAPPER, MARKET, [rec(q, booked)], PORTFOLIO), ...(memo !== undefined ? { memo } : {}) });
const target = { slab: SLAB, idx: 0, wallet: WALLET, portfolio: PORTFOLIO, wrapper: WRAPPER, qNow: Q };
const row = { slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: Q, portfolioPk: PORTFOLIO, entryPriceSource: "cache", account: { positionSize: Q } };

/** Device 1 opens P1 from flat with its own ticket: the measured Entry save and the trade book, as OrderTicket writes them (sig "open1"). */
function device1Opens(): void {
  saveEntryPrice(SLAB, 0, effective(P1), 2, WALLET, Q, { bookedPriceE6: P1, busyFeeAtoms: 0n, lastSig: "open1" });
  recordFill(WALLET, SLAB, PF, { q: Q, bookedPriceE6: P1, feeAtoms: fee(Q, P1), fundingBefore: BASE1, sig: "open1" }, 0n);
}

beforeEach(() => {
  localStorage.clear();
  __resetEntryChainSyncForTests();
  for (const k of Object.keys(txs)) delete txs[k];
  txs.open1 = fillTx(Q, P1, BASE1);
  for (let i = 0; i < 6; i++) txs[`k${i}`] = { logs: CRANK };
  txs.close1 = fillTx(-Q, 85_000_000n);
  txs.open2 = fillTx(Q, P2, BASE2);
  // newest first: device 2 closed P1 and reopened the same size; cranks around it
  order = ["k5", "k4", "open2", "k3", "close1", "k2", "k1", "k0", "open1"];
  h.nowQ = Q;
});

describe("same-size close + reopen on another device, seen from device 1", () => {
  it("device 1's own Entry record is re-checked against the chain (not trusted by size)", () => {
    device1Opens();
    expect(shouldSyncPosition(row, WALLET)).toBe(true);
  });

  it("after the check, Entry and the trade book are the NEW position's (Entry 90.207, funding base 500,000), never P1's", async () => {
    device1Opens();
    const v = await syncChainEntry(conn, target, () => 10_000_000);
    expect(v).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(effective(P2));
    expect(loadBookByWallet(WALLET, SLAB)).toMatchObject({ q: Q, avgE6: P2, fees: fee(Q, P2), fundingBase: BASE2 });
  });

  it("a close on device 1 before any check: the Trade result is unknown, not P1's book (+19.x USDC)", () => {
    device1Opens();
    // device 1 closes P2 flat at 90.00; the newest position change before the close is device 2's open2
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P2, feeAtoms: fee(Q, P2), funding: { netPaid: BASE2 + 300n, legs: 0 }, sig: "close2" }, Q, "open2");
    expect(r).toBeNull();
    expect(loadBook(WALLET, SLAB, PF)).toBeNull();
  });

  it("a close on device 1 after the check: the Trade result is P2's exact result (fees of open2 + close, funding 300)", async () => {
    device1Opens();
    await syncChainEntry(conn, target, () => 10_000_000);
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P2, feeAtoms: fee(Q, P2), funding: { netPaid: BASE2 + 300n, legs: 0 }, sig: "close2" }, Q, "open2");
    expect(r).toBe(0n - 2n * fee(Q, P2) - 300n);
  });

  it("the newest position change before a fill is found from chain, skipping cranks", async () => {
    order = ["close2", "k5", "k4", "open2", "k3", "close1", "k2", "k1", "k0", "open1"];
    txs.close2 = fillTx(-Q, P2);
    const prev = await prevChangeSig(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "close2" });
    expect(prev).toBe("open2");
  });
});

describe("device 1 when nothing happened elsewhere (no regression)", () => {
  beforeEach(() => {
    order = ["k2", "k1", "k0", "open1"];
  });

  it("its own Entry and book are confirmed and kept; a later check with only cranks reads only the new ones", async () => {
    device1Opens();
    expect(await syncChainEntry(conn, target, () => 10_000_000)).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(effective(P1));
    expect(loadBookByWallet(WALLET, SLAB)).toMatchObject({ q: Q, avgE6: P1, fundingBase: BASE1 });
    txs.k9 = { logs: CRANK };
    order = ["k9", ...order];
    expect(await syncChainEntry(conn, target, () => 10_000_000 + VERIFY_MS + 1)).toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(effective(P1));
  });

  it("its own close gives the exact result when the newest change before it is its own open", () => {
    device1Opens();
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P1, feeAtoms: fee(Q, P1), funding: { netPaid: BASE1 + 50n, legs: 0 }, sig: "close1" }, Q, "open1");
    expect(r).toBe(0n - 2n * fee(Q, P1) - 50n);
  });
});

describe("the chain check itself", () => {
  it("stops at a stored walk's top (only what is new is read); unknown when the fill is not listed yet", async () => {
    order = ["close2", "k5", "k4", "open2", "k3", "close1", "k2", "k1", "k0", "open1"];
    txs.close2 = fillTx(-Q, P2);
    const reads: string[] = [];
    const c = { ...(conn as object), getTransactions: vi.fn(async (s: string[]) => { reads.push(...s); return s.map(one); }) } as never;
    expect(await prevChangeSig(c, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "close2", known: { top: "k4", newest: "open2" } })).toBe("open2");
    expect(reads).toEqual(["k5"]);
    expect(await prevChangeSig(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "not-yet" })).toBeNull();
    expect(await prevChangeSig(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "close2", maxRead: 1 })).toBeNull();
  });

  it("a partial close keeps the Entry only when the record includes the chain's newest change before it", async () => {
    const { keepEntryAfterReduce } = await import("@/lib/entry-price");
    device1Opens();
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, Q, T, "part", "open2")).toBe(false); // the record is P1's; the chain's last change is P2's open
    expect(getSavedEntry(SLAB, 0, WALLET)?.sizeQ).toBe(Q);
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, Q, T, "part", "open1")).toBe(true);
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ sizeQ: T, lastSig: "part", entryPriceE6: effective(P1) });
  });

  it("a stale device record the chain cannot price (unexplained) is removed, not shown: Entry unknown until it can", async () => {
    device1Opens();
    // P2's open fee cannot be explained by base + the signed request (a busy-side fee on a market that may charge one)
    txs.open2 = { logs: fillEventLogs(WRAPPER, MARKET, [{ ...rec(Q, P2), feeAtoms: fee(Q, P2) * 3n }], PORTFOLIO), memo: BASE2 };
    const v = await syncChainEntry(conn, target, () => 10_000_000);
    expect(v).not.toBe("chain");
    expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
    expect(loadBookByWallet(WALLET, SLAB)?.avgE6).not.toBe(P1);
  });
});

/** Runs a promise that waits on paced timers (the sync paces its reads 1 s apart) under fake timers. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let out: T | undefined;
  void p.then((v) => { done = true; out = v; });
  for (let i = 0; i < 5000 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  return out as T;
}

describe("Council round 2 review: beyond the walk's reach", () => {
  const cranks = (n: number, tag: string) => Array.from({ length: n }, (_, i) => { txs[`${tag}${i}`] = { logs: CRANK }; return `${tag}${i}`; }).reverse();

  it("MED-1: the reopen elsewhere is older than the walk can read (2,000 txs): device 1's old Entry and book are removed (unknown), not shown", async () => {
    vi.useFakeTimers();
    try {
      device1Opens();
      order = [...cranks(2100, "n"), "open2", "k3", "close1", "k2", "k1", "k0", "open1"];
      const v = await drive(syncChainEntry(conn, target, () => 10_000_000));
      expect(v).toBe("incomplete");
      expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
      expect(loadBookByWallet(WALLET, SLAB)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("MED-1: the same long history with NO reopen (only cranks since device 1's open): its Entry and book stand; the next check within the hour reads only the signature list", async () => {
    vi.useFakeTimers();
    try {
      device1Opens();
      order = [...cranks(2100, "n"), "k2", "k1", "k0", "open1"];
      expect(await drive(syncChainEntry(conn, target, () => 10_000_000))).toBe("incomplete");
      expect(getSavedEntry(SLAB, 0, WALLET)?.entryPriceE6).toBe(effective(P1));
      expect(loadBookByWallet(WALLET, SLAB)?.avgE6).toBe(P1);
      const reads = (conn as unknown as { getTransactions: ReturnType<typeof vi.fn> }).getTransactions;
      reads.mockClear();
      expect(await drive(syncChainEntry(conn, target, () => 10_000_000 + VERIFY_MS + 1))).toBe("incomplete");
      expect(reads).not.toHaveBeenCalled(); // no second 2,000-transaction walk
      // a reopen elsewhere lands now: the minute check (signature list only) catches it
      txs.close9 = fillTx(-Q, P2);
      txs.open9 = fillTx(Q, P2, BASE2);
      order = ["open9", "close9", ...order];
      await drive(syncChainEntry(conn, target, () => 10_000_000 + 2 * VERIFY_MS + 2));
      expect(getSavedEntry(SLAB, 0, WALLET)).toBeNull();
      expect(loadBookByWallet(WALLET, SLAB)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("MED-2: device 1's own close after a long gap with no stored walk keeps its exact result (the signature list back to its own open shows no reopen)", async () => {
    device1Opens();
    txs.close1x = fillTx(-Q, P1);
    order = ["close1x", ...cranks(400, "g"), "open1"];
    const prev = await prevChangeBeforeFill(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, sig: "close1x", recordSig: "open1" }, { paceMs: 0 });
    expect(prev).toBe("open1");
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P1, feeAtoms: fee(Q, P1), funding: { netPaid: BASE1 + 50n, legs: 0 }, sig: "close1x" }, Q, prev);
    expect(r).toBe(0n - 2n * fee(Q, P1) - 50n);
  });

  it("MED-2: the same long gap, but the position was closed and reopened elsewhere: the check names the reopen, the result is unknown", async () => {
    device1Opens();
    txs.close2x = fillTx(-Q, P2);
    order = ["close2x", ...cranks(400, "g"), "open2", "close1", ...cranks(5, "h"), "open1"];
    const prev = await prevChangeBeforeFill(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, sig: "close2x", recordSig: "open1" }, { paceMs: 0 });
    expect(prev).toBe("open2");
    expect(recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P2, feeAtoms: fee(Q, P2), funding: { netPaid: BASE2 + 1n, legs: 0 }, sig: "close2x" }, Q, prev)).toBeNull();
  });

  it("the check stops at the record's own fill; it is retried only while the fill is not listed yet, not after its read limit", async () => {
    txs.close1x = fillTx(-Q, P1);
    order = ["close1x", "k1", "k0", "open1"];
    expect(await prevChangeCheck(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "close1x", stopAt: "k0" })).toEqual({ kind: "sig", sig: "k0" });
    expect(await prevChangeCheck(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "nope" })).toEqual({ kind: "not-listed" });
    const sigsCalls = (conn as unknown as { getSignaturesForAddress: ReturnType<typeof vi.fn> }).getSignaturesForAddress;
    order = ["close1x", ...cranks(300, "g"), "open1"];
    sigsCalls.mockClear();
    expect(await prevChangeBeforeFill(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, sig: "close1x" }, { paceMs: 0, waitMs: 0 })).toBeNull(); // no record sig: no list fallback
    expect(sigsCalls.mock.calls.length).toBeLessThanOrEqual(3); // one bounded pass, no retries
    order = ["k1", "k0"];
    expect(await openSinceCheck(conn, PORTFOLIO, { untilSig: "missing" })).toEqual({ kind: "unknown" }); // never reached: cannot tell
  });
});
