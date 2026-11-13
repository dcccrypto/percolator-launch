/**
 * Council r10 recheck, the two Clerk gaps.
 *
 * D1: the close estimate (and the close toast) include funding on EVERY device. The open from flat carries the portfolio's funding counter in
 * a memo; the chain walk reads it and rebuilds the same trade book the trading device keeps, so both devices compute the same funding and no
 * close surface says "excl. funding" when the chain has the counter.
 *
 * D6: Entry is recovered on a second device for holds far past the old 60-transaction walk (keeper cranks no longer count against it, and a
 * later rebuild only reads what is new), and the trading device keeps Entry after a partial close. "Unknown" stays for what the chain cannot
 * prove (no memo, a REDUCE the book cannot follow, a truncated log in a transaction that ran the wrapper, the read budget exhausted).
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { fillEventLogs } from "../helpers/fill-event-fixture";
import { bookFromDeltas, entryFromChain, loadDeltas, storeDeltas, txNamesProgram, type ChainDelta } from "@/lib/entry-chain";
import { MEMO_PROGRAM_ID, fundingBaseFromTx, fundingMemoIx, legacyTxSize, memoBaseFor, memoIfFits, noteMemoBase, ticketFillIn, newPortfolioFundingMemoIx, openFundingMemoIx, sendWithFundingMemo } from "@/lib/funding-memo";
import { applyFill, loadBook, loadBookByWallet, recordFill, saveBook } from "@/lib/trade-book";
import { computePositionPnl } from "@/lib/position-pnl";
import { keepEntryAfterReduce, getSavedEntry, markEntryUnknown, saveEntryPrice } from "@/lib/entry-price";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";

const WRAPPER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey.toBase58();
const SLAB = MARKET.toBase58();
const T = 1_000_000n;
const BASE = 30n;
const abs = (n: bigint) => (n < 0n ? -n : n);

function rec(q: bigint, booked: bigint, spreadBps: bigint) {
  const notional = (abs(q) * booked) / 1_000_000n;
  const quoted = q > 0n ? booked + (booked * spreadBps) / 10_000n : booked - (booked * spreadBps) / 10_000n;
  return { flags: 8, requestedQ: q, executedQ: q, priceE6: booked, quotedPriceE6: quoted, feeAtoms: (notional * (BASE + spreadBps)) / 10_000n };
}
const effective = (q: bigint, booked: bigint, spreadBps: bigint) => (q > 0n ? booked + (booked * spreadBps) / 10_000n : booked - (booked * spreadBps) / 10_000n);

type Tx = { logs: string[]; memo?: bigint; wrapperFree?: boolean };
const W = WRAPPER.toBase58();
/** A keeper crank as it lands on devnet: three wrapper instructions, no event, no size change. */
const CRANK: Tx = { logs: [0, 1, 2].flatMap(() => [`Program ${W} invoke [1]`, `Program ${W} consumed 160425 of 1399700 compute units`, `Program ${W} success`]) };
const fill = (q: bigint, booked: bigint, spread: bigint, memo?: bigint): Tx => ({ logs: fillEventLogs(WRAPPER, MARKET, [rec(q, booked, spread)], PORTFOLIO), ...(memo !== undefined ? { memo } : {}) });

/** A devnet-shaped connection over a newest-first signature list. Records every transaction read. */
function conn(txs: Record<string, Tx>, order: () => string[]) {
  const reads: string[] = [];
  const getSignaturesForAddress = vi.fn(async (_pk: PublicKey, o: { limit?: number; before?: string }) => {
    const list = order();
    const start = o.before ? list.indexOf(o.before) + 1 : 0;
    return list.slice(start, start + (o.limit ?? 1000)).map((signature) => ({ signature, slot: 1, err: null, memo: null, blockTime: 0 }));
  });
  const one = (sig: string) => {
    reads.push(sig);
    const t = txs[sig];
    const keys: PublicKey[] = t.wrapperFree ? [] : [WRAPPER];
    const ixs: { programIdIndex: number; data: Uint8Array }[] = [];
    if (t.memo !== undefined) {
      keys.push(MEMO_PROGRAM_ID);
      ixs.push({ programIdIndex: keys.length - 1, data: new Uint8Array(fundingMemoIx(t.memo).data) });
    }
    return { slot: 1, meta: { err: null, logMessages: t.logs }, transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } } };
  };
  const getTransaction = vi.fn(async (sig: string) => one(sig));
  const getTransactions = vi.fn(async (sigs: string[]) => sigs.map(one));
  return { c: { getSignaturesForAddress, getTransaction, getTransactions } as unknown as Parameters<typeof entryFromChain>[0], reads, getTransactions };
}
const walk = (c: Parameters<typeof entryFromChain>[0], qNow: bigint, o: Partial<Parameters<typeof entryFromChain>[2]> = {}) =>
  entryFromChain(c, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, qNow, baseFeeBps: BASE, mayChargeBusy: false, ...o });

beforeEach(() => localStorage.clear());

// ── D1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("D1: the funding memo on the opening fill", () => {
  it("round-trips the counter through the signed instruction data; anything else reads as none", () => {
    const ix = fundingMemoIx(419_035n);
    expect(ix.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(ix.keys).toHaveLength(0); // no signer account: it cannot fail on its own
    expect(Buffer.from(ix.data).toString("utf8")).toBe("perc:fb1:419035");
    const msg = (datas: string[], pid = MEMO_PROGRAM_ID) => ({ staticAccountKeys: [pid], compiledInstructions: datas.map((d) => ({ programIdIndex: 0, data: new Uint8Array(Buffer.from(d)) })) });
    expect(fundingBaseFromTx(msg(["perc:fb1:419035"]))).toBe(419_035n);
    expect(fundingBaseFromTx(msg(["perc:fb1:-3118"]))).toBe(-3_118n); // net paid can be negative (received more)
    expect(fundingBaseFromTx(msg(["perc:fb1:1", "perc:fb1:2"]))).toBeNull(); // two: never guess
    expect(fundingBaseFromTx(msg(["perc:fb1:12x"]))).toBeNull();
    expect(fundingBaseFromTx(msg(["hello"]))).toBeNull();
    expect(fundingBaseFromTx(msg(["perc:fb1:5"], Keypair.generate().publicKey))).toBeNull(); // not the memo program
  });

  it("is written only for an open from flat with no active leg (the counters cannot move until the fill)", () => {
    const flat0 = { q: 0n, funding: { netPaid: 415_917n, legs: 0 } };
    expect(Buffer.from(openFundingMemoIx(flat0)!.data).toString()).toBe("perc:fb1:415917");
    expect(openFundingMemoIx({ q: T, funding: { netPaid: 1n, legs: 1 } })).toBeNull(); // an add
    expect(openFundingMemoIx({ q: 0n, funding: { netPaid: 1n, legs: 1 } })).toBeNull(); // another leg could settle in between
    expect(openFundingMemoIx({ q: 0n, funding: null })).toBeNull();
    expect(openFundingMemoIx(null)).toBeNull();
    expect(Buffer.from(newPortfolioFundingMemoIx().data).toString()).toBe("perc:fb1:0"); // a brand-new portfolio starts at zero
  });

  it("never blocks a trade: dropped when the transaction would not fit, retried without it on a too-large error, other errors untouched", async () => {
    const payer = Keypair.generate().publicKey;
    const small = [new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.alloc(85) })];
    const memo = fundingMemoIx(7n);
    expect(memoIfFits(small, memo, payer)).toBe(memo);
    const big = [new TransactionInstruction({ programId: WRAPPER, keys: [], data: Buffer.alloc(1000) })];
    expect(memoIfFits(big, memo, payer)).toBeNull();
    // counted from the wire format (checked by hand against the round-10 open 4tFiWLNC: 702 bytes both ways)
    expect(legacyTxSize(small, payer)).toBe(1 + 64 + 3 + 1 + 64 + 32 + 1 + (1 + 1 + 0 + 1 + 85));

    const sent: number[] = [];
    const sig = await sendWithFundingMemo(small, memo, async (ixs) => { sent.push(ixs.length); return "sigOK"; }, payer);
    expect(sig).toBe("sigOK");
    expect(sent).toEqual([2]);
    expect(memoBaseFor("sigOK")).toBe(7n); // the trading device's own book uses the same number

    sent.length = 0;
    await sendWithFundingMemo(small, memo, async (ixs) => { sent.push(ixs.length); if (ixs.length === 2) throw new Error("Transaction too large: 1300 > 1232"); return "sig2"; });
    expect(sent).toEqual([2, 1]);
    await expect(sendWithFundingMemo(small, memo, async () => { throw new Error("custom program error: 0x9"); })).rejects.toThrow("0x9");
  });
});

describe("D1: the trading device's own book entry", () => {
  it("an open from flat takes the base this device wrote into the memo; any other fill does not", () => {
    noteMemoBase("sigTicket", 415_917n);
    const f = { executedQ: 2n * T, bookedPriceE6: 80_000_000n, feeAtoms: 9n };
    expect(ticketFillIn(f, null, 0n, "sigTicket")).toEqual({ q: 2n * T, bookedPriceE6: 80_000_000n, feeAtoms: 9n, funding: null, fundingBefore: 415_917n });
    expect(ticketFillIn(f, null, T, "sigTicket").fundingBefore).toBeNull(); // an add
    expect(ticketFillIn(f, null, 0n, "otherSig").fundingBefore).toBeNull(); // no memo was written
    // the book then carries that base even when the post-fill read failed
    expect(applyFill(null, ticketFillIn(f, null, 0n, "sigTicket")).book?.fundingBase).toBe(415_917n);
  });
});

describe("D1: both devices compute the same funding, and no close surface says 'excl. funding'", () => {
  // Shaped like the round-10 live position: a long opened at booked ~80, half closed, the counter 415,917 before the open and 419,035 now.
  const BOOKED = 80_000_000n;
  const OPEN = 2n * T;
  const BASE_AT_OPEN = 415_917n;

  it("the trading device's book (memo base) and the book rebuilt from chain on device 2 are identical, through a partial close", async () => {
    // Device 1: the book it records itself (the ticket passes the memo base it wrote as fundingBefore).
    recordFill(WALLET, SLAB, PORTFOLIO.toBase58(), { q: OPEN, bookedPriceE6: BOOKED, feeAtoms: rec(OPEN, BOOKED, 23n).feeAtoms, funding: null, fundingBefore: BASE_AT_OPEN }, 0n);
    recordFill(WALLET, SLAB, PORTFOLIO.toBase58(), { q: -T, bookedPriceE6: 80_020_000n, feeAtoms: rec(-T, 80_020_000n, 23n).feeAtoms, funding: null }, OPEN);
    const dev1 = loadBook(WALLET, SLAB, PORTFOLIO.toBase58());

    // Device 2: empty storage; the walk over the same transactions (cranks in between) with the memo on the opening fill.
    const txs: Record<string, Tx> = { open: fill(OPEN, BOOKED, 23n, BASE_AT_OPEN), part: fill(-T, 80_020_000n, 23n) };
    const order: string[] = ["part"];
    for (let i = 0; i < 90; i++) { txs[`k${i}`] = CRANK; order.push(`k${i}`); }
    order.push("open");
    const { c } = conn(txs, () => order);
    const r = await walk(c, T);
    expect(r.verdict).toBe("chain");
    const dev2 = bookFromDeltas(r.positionDeltas!, r.startQ!, T);
    expect(dev2).toEqual(dev1);
    expect(dev2?.fundingBase).toBe(BASE_AT_OPEN);

    // Same book -> same funding so far on every surface (they all go through computePositionPnl), never null.
    const pnl = (book: typeof dev1) =>
      computePositionPnl({
        basisQ: T, aBasis: 1_000_000n, adlFactors: null, adlApplicable: false, markE6: 80_000_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: 20n * T,
        cachedEntryE6: 80_000_000n, activeLegCount: 1, fundingNetPaidAtoms: 419_035n,
        riskLeg: { side: 0, fSnap: 0n, kSnap: 0n, epochSnap: 0n, kfEpochSnap: 0n, stale: false } as never,
        cachedFundingBook: book ? { fundingBase: book.fundingBase, q: book.q } : null,
      }).fundingPaidAtoms;
    // (no ADL factors here: the pending part is unknown, so this checks the book half; the full figure is pinned below with pending known)
    expect(pnl(dev1)).toBe(pnl(dev2));
  });

  it("with the counters and pending funding known, the dialog shows the funding row and no 'excl. funding' tag on either device", () => {
    const book = applyFill(null, { q: OPEN, bookedPriceE6: BOOKED, feeAtoms: 100n, funding: null, fundingBefore: BASE_AT_OPEN }).book!;
    // settled since the open (419,035 - 415,917 = 3,118) + pending 64 = 3,182 atoms paid
    const funding = 419_035n - book.fundingBase! + 64n;
    for (const device of ["trading device", "second profile"]) {
      const { unmount } = render(
        <ClosePositionForm positionSize={OPEN} entryPrice={79_946_562n} currentPrice={80_000_000n} capital={20n * T} symbol="SOL" collateralSymbol="USDC" decimals={6} priceUsd={1} isLong loading={false} tradingFeeBps={30n} fundingPaidAtoms={funding} onConfirm={() => {}} />,
      );
      expect(screen.queryByTestId("close-net-excl-funding"), device).toBeNull();
      expect(screen.getByText("Funding paid so far:")).toBeInTheDocument();
      unmount();
    }
  });

  it("the close toast on device 2 counts the rebuilt book: the same Trade result as the trading device would have", () => {
    const book = applyFill(null, { q: OPEN, bookedPriceE6: BOOKED, feeAtoms: 368_000n, funding: null, fundingBefore: BASE_AT_OPEN }).book!;
    saveBook(WALLET, SLAB, PORTFOLIO.toBase58(), book); // what the sync stores on device 2
    const close = { q: -OPEN, bookedPriceE6: 79_603_764n, feeAtoms: 430_000n, funding: { netPaid: 419_345n, legs: 0 } };
    const dev2 = recordFill(WALLET, SLAB, PORTFOLIO.toBase58(), close, OPEN);
    const dev1 = applyFill(book, close).closedResult;
    expect(dev2).toBe(dev1);
    // price PnL 2 x (79.603764 - 80.000000) = -792,472; fees 798,000; funding 419,345 - 415,917 = 3,428
    expect(dev2).toBe(-792_472n - 798_000n - 3_428n);
  });

  it("unknown only when the chain cannot state the base: no memo, or a position that started by flipping through flat", () => {
    const noMemo: ChainDelta[] = [{ sig: "o", deltaQ: OPEN, fill: { bookedPriceE6: BOOKED, executedQ: OPEN, feeAtoms: 1n, notionalAtoms: 1n, taker: PORTFOLIO, quotedPriceE6: 0n, legs: 1 } }];
    expect(bookFromDeltas(noMemo, 0n, OPEN)?.fundingBase).toBeNull(); // the estimate then says "excl. funding": honest
    expect(bookFromDeltas([{ ...noMemo[0], fundingBase: 5n }], -T, OPEN)).toBeNull(); // flip start: the base is after a settle
    expect(bookFromDeltas([{ ...noMemo[0], fundingBase: 5n }, { sig: "adl", deltaQ: -T }], 0n, T)).toBeNull(); // a REDUCE: the book follows fills only
  });

  it("the sync stores the rebuilt book where every surface reads it, and fills in a base the device's own book lacks", async () => {
    const { storeChainBook } = await import("@/lib/entry-chain-sync");
    const deltas: ChainDelta[] = [{ sig: "o", deltaQ: OPEN, fundingBase: BASE_AT_OPEN, fill: { bookedPriceE6: BOOKED, executedQ: OPEN, feeAtoms: 9n, notionalAtoms: 1n, taker: PORTFOLIO, quotedPriceE6: 0n, legs: 1 } }];
    const t = { wallet: WALLET, slab: SLAB, portfolio: PORTFOLIO, qNow: OPEN };
    expect(storeChainBook(t, { positionDeltas: deltas, startQ: 0n })).toBe(true);
    expect(loadBookByWallet(WALLET, SLAB)?.fundingBase).toBe(BASE_AT_OPEN);
    // a device book of the same size with an unread base (a post-trade read that hit a rate limit) gets the chain's base, nothing else changes
    saveBook(WALLET, SLAB, PORTFOLIO.toBase58(), { q: OPEN, avgE6: BOOKED, fees: 9n, pnl: 0n, fundingBase: null });
    expect(storeChainBook(t, { positionDeltas: deltas, startQ: 0n })).toBe(true);
    expect(loadBook(WALLET, SLAB, PORTFOLIO.toBase58())).toEqual({ q: OPEN, avgE6: BOOKED, fees: 9n, pnl: 0n, fundingBase: BASE_AT_OPEN });
    // a complete device book of the same size is the trading device's own: left alone
    saveBook(WALLET, SLAB, PORTFOLIO.toBase58(), { q: OPEN, avgE6: BOOKED, fees: 9n, pnl: 0n, fundingBase: 1n });
    expect(storeChainBook(t, { positionDeltas: deltas, startQ: 0n })).toBe(false);
    expect(loadBook(WALLET, SLAB, PORTFOLIO.toBase58())?.fundingBase).toBe(1n);
  });
});

// ── D6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("D6: Entry on a second device for ordinary holds", () => {
  const OPEN = 2n * T;
  /** A hold of `minutes` with a keeper crank every 20 s (what round 10 measured on portfolio 5dsrhZ). */
  const hold = (minutes: number) => {
    const txs: Record<string, Tx> = { open: fill(OPEN, 100_000_000n, 23n, 0n) };
    const order: string[] = [];
    for (let i = 0; i < minutes * 3; i++) { txs[`k${i}`] = CRANK; order.push(`k${i}`); }
    order.push("open");
    return { txs, order };
  };

  it("a 2-hour hold (360 cranks) is recovered; the old 60-transaction walk gave 'incomplete' on the same history", async () => {
    const { txs, order } = hold(120);
    const { c } = conn(txs, () => order);
    const r = await walk(c, OPEN);
    expect(r.verdict).toBe("chain");
    expect(r.entry?.entryPriceE6).toBe(effective(OPEN, 100_000_000n, 23n));
    expect(r.changesRead).toBe(1); // only the fill counted against maxTx
    // the round-10 bound: every transaction counted, 60 at most
    expect((await walk(conn(txs, () => order).c, OPEN, { maxRead: 60 })).verdict).toBe("incomplete");
  });

  it("reads in batches (one request per group), not one request per transaction", async () => {
    const { txs, order } = hold(30);
    const k = conn(txs, () => order);
    await walk(k.c, OPEN, { concurrency: 10 });
    expect(k.getTransactions.mock.calls.length).toBeLessThanOrEqual(Math.ceil(91 / 10) + 1);
  });

  it("a later rebuild resumes at the stored top: it reads only the new transactions, and a partial close made elsewhere keeps the Entry", async () => {
    const { txs, order } = hold(60);
    const k = conn(txs, () => order);
    const first = await walk(k.c, OPEN);
    expect(first.verdict).toBe("chain");
    const stored = { topSig: first.topSig!, qAtTop: OPEN, startQ: first.startQ!, deltas: loadDeltas(JSON.parse(JSON.stringify(storeDeltas(first.positionDeltas!))), (s) => new PublicKey(s))! };
    // 30 more cranks and a partial close on device 1
    txs.part = fill(-T, 101_000_000n, 23n);
    const newer = ["part"];
    for (let i = 0; i < 30; i++) { txs[`n${i}`] = CRANK; newer.push(`n${i}`); }
    const later = [...newer, ...order];
    const k2 = conn(txs, () => later);
    const second = await walk(k2.c, T, { resume: stored });
    expect(second.verdict).toBe("chain");
    expect(second.entry?.entryPriceE6).toBe(first.entry?.entryPriceE6); // a reduce keeps the average
    expect(second.entry?.sizeQ).toBe(T);
    expect(k2.reads.length).toBe(31); // only what is new
    expect(second.positionDeltas?.map((d) => d.sig)).toEqual(["open", "part"]);
  });

  it("a resume that does not join up exactly (silent ADL scaling) is dropped and the walk starts over: never a wrong Entry", async () => {
    const { txs, order } = hold(5);
    const first = await walk(conn(txs, () => order).c, OPEN);
    const bad = { topSig: first.topSig!, qAtTop: 3n * T, startQ: 0n, deltas: first.positionDeltas! };
    const k = conn(txs, () => order);
    const r = await walk(k.c, OPEN, { resume: bad });
    expect(r.verdict).toBe("chain");
    expect(k.reads.length).toBe(16); // read again from scratch
  });

  it("a transaction that never ran the wrapper is skipped even with a truncated log; one that ran it stays unreadable", async () => {
    const txs: Record<string, Tx> = { open: fill(OPEN, 100_000_000n, 23n), spam: { logs: ["Program 11111111111111111111111111111111 invoke [1]", "Log truncated"], wrapperFree: true } };
    expect((await walk(conn(txs, () => ["spam", "open"]).c, OPEN)).verdict).toBe("chain");
    txs.spam = { logs: [...CRANK.logs, "Log truncated"] };
    expect((await walk(conn(txs, () => ["spam", "open"]).c, OPEN)).verdict).toBe("unreadable");
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [] } }, meta: { loadedAddresses: { writable: [], readonly: [W] } } }, WRAPPER)).toBe(true);
    // a wrapper-free transaction with NO logs at all (unreadable if parsed) is skipped too
    txs.spam = { logs: [], wrapperFree: true };
    expect((await walk(conn(txs, () => ["spam", "open"]).c, OPEN)).verdict).toBe("chain");
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [] } }, meta: { loadedAddresses: { writable: [], readonly: [] } } }, WRAPPER)).toBe(false);
  });

  it("past the read budget it is still honest: incomplete, nothing guessed", async () => {
    const { txs, order } = hold(30);
    const r = await walk(conn(txs, () => order).c, OPEN, { maxRead: 50 });
    expect(r.verdict).toBe("incomplete");
    expect(r.entry).toBeNull();
  });
});

describe("D6: the trading device keeps Entry after a partial close", () => {
  it("a reconciled reduce moves the saved record to the size left, same Entry and basis, busy share scaled", () => {
    saveEntryPrice(SLAB, 0, 79_946_562n, 2, WALLET, 501_685n, { bookedPriceE6: 79_763_105n, busyFeeAtoms: 1000n });
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 501_685n, 250_843n)).toBe(true);
    expect(getSavedEntry(SLAB, 0, WALLET)).toMatchObject({ entryPriceE6: 79_946_562n, bookedPriceE6: 79_763_105n, sizeQ: 250_843n, busyFeeAtoms: 500n, leverage: 2 });
    // what the dialog then shows: a current record, so a real Entry and PnL (round 10 showed "unknown entry" and "--")
    const p = computePositionPnl({ basisQ: 250_843n, aBasis: 0n, adlFactors: null, adlApplicable: false, markE6: 80_000_000n, onChainPnl: 0n, initialMarginBps: 1000n, capital: 20n * T, cachedEntryE6: 79_946_562n, cachedEntryCheck: { sizeQ: 250_843n, pending: false } });
    expect(p.entrySource).toBe("cache");
    expect(p.pnlKnown).toBe(true);
  });

  it("not reconciled, a flip, a close to flat, or a position marked unknown: the record is not touched", () => {
    saveEntryPrice(SLAB, 0, 79_946_562n, 2, WALLET, 501_685n);
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 400_000n, 200_000n)).toBe(false); // the record is for another size
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 501_685n, -100n)).toBe(false); // flip
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 501_685n, 0n)).toBe(false); // flat: the close clears it
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 501_685n, 600_000n)).toBe(false); // an add is not a reduce
    markEntryUnknown(SLAB, 0, WALLET, 501_685n, "sigX");
    expect(keepEntryAfterReduce(SLAB, 0, WALLET, 501_685n, 250_843n)).toBe(false);
    expect(getSavedEntry(SLAB, 0, WALLET)?.sizeQ).toBe(501_685n);
  });
});
