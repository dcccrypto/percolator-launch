/** Coverage for lib/entry-chain.ts: prevChangeCheck, walletChangeCheck, txNamesProgram, bookFromDeltas, resume, storage form, walk limits. */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fillEventLogs, reduceEventLogs } from "../helpers/fill-event-fixture";
import {
  bookFromDeltas,
  deltasFromLogs,
  entryFromChain,
  loadDeltas,
  prevChangeCheck,
  prevChangeSig,
  storeDeltas,
  txNamesProgram,
  walletChangeCheck,
  type ChainDelta,
} from "@/lib/entry-chain";
import { MEMO_PROGRAM_ID } from "@/lib/funding-memo";

const WRAPPER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey;
const NFT = Keypair.generate().publicKey;
const T = 1_000_000n;
const BASE = 30n;
const P = { market: MARKET, portfolio: PORTFOLIO };

const fillRec = (q: bigint, booked = 100_000_000n) => {
  const notional = ((q < 0n ? -q : q) * booked) / 1_000_000n;
  return { flags: 8, requestedQ: q, executedQ: q, priceE6: booked, quotedPriceE6: 0n, feeAtoms: (notional * BASE) / 10_000n };
};
const FILL = (q: bigint, booked?: bigint) => fillEventLogs(WRAPPER, MARKET, [fillRec(q, booked)], PORTFOLIO);
const CRANK = [`Program ${WRAPPER.toBase58()} invoke [1]`, `Program ${WRAPPER.toBase58()} success`];

type Tx = {
  logs?: string[];
  err?: unknown;
  slot?: number;
  keys?: unknown[] | null;
  ixs?: { programIdIndex: number; data: Uint8Array }[];
  loaded?: { writable?: unknown[]; readonly?: unknown[] };
  noMeta?: boolean;
};

function mk(txs: Record<string, Tx>, order: string[], opt: { batch?: boolean; statusSlot?: number | null; sigFail?: boolean; noBatchFail?: boolean } = {}) {
  const getSignaturesForAddress = vi.fn(async (_pk: PublicKey, o: { limit?: number; before?: string }) => {
    if (opt.sigFail) throw new Error("rpc");
    const start = o.before ? order.indexOf(o.before) + 1 : 0;
    return order.slice(start, start + (o.limit ?? 1000)).map((signature) => ({ signature, slot: txs[signature]?.slot ?? 1, err: txs[signature]?.err ?? null, memo: null, blockTime: 0 }));
  });
  const one = (sig: string) => {
    const t = txs[sig];
    if (!t || t.noMeta) return null;
    const keys = t.keys === undefined ? [WRAPPER] : t.keys;
    return {
      slot: t.slot ?? 1,
      meta: { err: t.err ?? null, logMessages: t.logs ?? CRANK, loadedAddresses: t.loaded },
      transaction: { message: keys === null ? {} : { staticAccountKeys: keys, compiledInstructions: t.ixs ?? [] } },
    };
  };
  const getTransaction = vi.fn(async (sig: string) => one(sig));
  const getTransactions = vi.fn(async (sigs: string[]) => sigs.map(one));
  const getSignatureStatuses = vi.fn(async () => ({ value: [opt.statusSlot === null ? null : { slot: opt.statusSlot ?? 5 }] }));
  return { getSignaturesForAddress, getTransaction, ...(opt.batch ? { getTransactions } : {}), getSignatureStatuses, _getTransactions: getTransactions } as unknown as Parameters<typeof prevChangeCheck>[0] & Parameters<typeof walletChangeCheck>[0] & { _getTransactions: typeof getTransactions };
}

describe("txNamesProgram", () => {
  it("handles unknown shape, accountKeys, string keys, loaded addresses and absence", () => {
    expect(txNamesProgram(null, WRAPPER)).toBe(true);
    expect(txNamesProgram({ transaction: { message: {} } }, WRAPPER)).toBe(true);
    expect(txNamesProgram({ transaction: { message: { accountKeys: [WRAPPER] } } }, WRAPPER)).toBe(true);
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [WRAPPER.toBase58()] } } }, WRAPPER)).toBe(true);
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [MARKET, 5 as unknown as PublicKey] } } }, WRAPPER)).toBe(false);
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [] } }, meta: { loadedAddresses: { writable: [MARKET], readonly: [WRAPPER] } } }, WRAPPER)).toBe(true);
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [] } }, meta: { loadedAddresses: {} } }, WRAPPER)).toBe(false);
    expect(txNamesProgram({ transaction: { message: { staticAccountKeys: [] } }, meta: null }, WRAPPER)).toBe(false);
  });
});

describe("deltasFromLogs edge cases", () => {
  it("a failed transaction is no change; unreadable logs are null", () => {
    expect(deltasFromLogs("s", FILL(T), false, WRAPPER, { ...P, assetIndex: 0 })).toEqual([]);
    expect(deltasFromLogs("s", null, true, WRAPPER, { ...P, assetIndex: 0 })).toBeNull();
  });
  it("a fill of another taker is no change", () => {
    const other = fillEventLogs(WRAPPER, MARKET, [fillRec(T)], Keypair.generate().publicKey);
    expect(deltasFromLogs("s", other, true, WRAPPER, { ...P, assetIndex: 0 })).toEqual([]);
  });
});

describe("bookFromDeltas", () => {
  const fillD = (q: bigint, sig: string, fundingBase?: bigint | null): ChainDelta => ({
    sig,
    deltaQ: q,
    fill: { bookedPriceE6: 100_000_000n, executedQ: q, feeAtoms: 10n, notionalAtoms: 1000n, taker: PORTFOLIO, quotedPriceE6: 0n, legs: 1 },
    ...(fundingBase !== undefined ? { fundingBase } : {}),
  });
  it("null for a non-flat start, no deltas, a REDUCE, or a size that does not match", () => {
    expect(bookFromDeltas([fillD(T, "a")], 1n, T)).toBeNull();
    expect(bookFromDeltas([], 0n, T)).toBeNull();
    expect(bookFromDeltas([fillD(T, "a"), { sig: "b", deltaQ: -1n }], 0n, 0n)).toBeNull();
    expect(bookFromDeltas([fillD(T, "a")], 0n, 2n * T)).toBeNull();
  });
  it("uses the opening memo as funding base, or leaves it unknown when absent", () => {
    const withMemo = bookFromDeltas([fillD(T, "a", 7n), fillD(T, "b")], 0n, 2n * T);
    expect(withMemo?.q).toBe(2n * T);
    expect(withMemo?.fundingBase).toBe(7n);
    expect(withMemo?.lastSig).toBe("b");
    const noMemo = bookFromDeltas([fillD(T, "a")], 0n, T);
    expect(noMemo?.fundingBase).toBeNull();
  });
});

describe("storeDeltas / loadDeltas", () => {
  const keyOf = (s: string) => new PublicKey(s);
  const full: ChainDelta[] = [
    { sig: "r", deltaQ: -3n },
    {
      sig: "f",
      deltaQ: 5n,
      fill: { bookedPriceE6: 1n, executedQ: 5n, feeAtoms: 2n, notionalAtoms: 3n, taker: PORTFOLIO, quotedPriceE6: 4n, legs: 1 },
      signedFeeBps: 135n,
      noBusyCap: { feeBps: 135n, maxFeeBps: 700n },
      fundingBase: -9n,
    },
    { sig: "n", deltaQ: 1n, signedFeeBps: null, noBusyCap: null },
  ];
  it("round-trips", () => {
    const s = storeDeltas(full);
    expect(s[0]).toEqual({ sig: "r", dq: "-3" });
    expect(loadDeltas(JSON.parse(JSON.stringify(s)), keyOf)).toEqual(full);
  });
  it("rejects malformed input", () => {
    expect(loadDeltas("x", keyOf)).toBeNull();
    expect(loadDeltas([null], keyOf)).toBeNull();
    expect(loadDeltas([{ sig: 1, dq: "1" }], keyOf)).toBeNull();
    expect(loadDeltas([{ sig: "a", dq: "1.5" }], keyOf)).toBeNull();
    const f = { b: "1", q: "1", fee: "1", n: "1", t: PORTFOLIO.toBase58(), qp: "1", l: 1 };
    expect(loadDeltas([{ sig: "a", dq: "1", f: { ...f, b: "x" } }], keyOf)).toBeNull();
    expect(loadDeltas([{ sig: "a", dq: "1", f: { ...f, l: "1" } }], keyOf)).toBeNull();
    expect(loadDeltas([{ sig: "a", dq: "1", f: { ...f, t: 5 } }], keyOf)).toBeNull();
    // a throwing key parser is caught
    expect(loadDeltas([{ sig: "a", dq: "1", f }], () => { throw new Error("bad key"); })).toBeNull();
  });
  it("tolerates a bad signed fee / cap / funding base (dropped to null)", () => {
    const out = loadDeltas([{ sig: "a", dq: "1", sf: "zz", cap: { f: "1", m: "q" }, fb: "nope" }], keyOf);
    expect(out).toEqual([{ sig: "a", deltaQ: 1n, signedFeeBps: null, noBusyCap: null }]);
    expect(loadDeltas([{ sig: "a", dq: "1", sf: "12", cap: { f: "1", m: "2" }, fb: "3" }], keyOf)).toEqual([{ sig: "a", deltaQ: 1n, signedFeeBps: 12n, noBusyCap: { feeBps: 1n, maxFeeBps: 2n }, fundingBase: 3n }]);
  });
});

describe("prevChangeCheck / prevChangeSig", () => {
  const run = (c: ReturnType<typeof mk>, o: Partial<Parameters<typeof prevChangeCheck>[2]> = {}) => prevChangeCheck(c, WRAPPER, { ...P, beforeSig: "b", ...o });

  it("finds the newest older change, skipping cranks, failed and non-wrapper transactions", async () => {
    const c = mk({ n: {}, b: {}, crank: {}, failed: { err: {} }, other: { keys: [MARKET], logs: [] }, hit: { logs: FILL(T) } }, ["n", "b", "crank", "failed", "other", "hit"]);
    expect(await run(c)).toEqual({ kind: "sig", sig: "hit" });
    expect(await prevChangeSig(c, WRAPPER, { ...P, beforeSig: "b" })).toBe("hit");
  });
  it("reads through getTransactions when available", async () => {
    const c = mk({ b: {}, hit: { logs: FILL(T) } }, ["b", "hit"], { batch: true });
    expect(await run(c)).toEqual({ kind: "sig", sig: "hit" });
    expect(c._getTransactions).toHaveBeenCalled();
  });
  it("not-listed when beforeSig is missing, or the list is empty", async () => {
    expect(await run(mk({ x: {} }, ["x"]))).toEqual({ kind: "not-listed" });
    expect(await run(mk({}, []))).toEqual({ kind: "not-listed" });
    expect(await prevChangeSig(mk({}, []), WRAPPER, { ...P, beforeSig: "b" })).toBeNull();
  });
  it("unknown when the list ends, on an RPC error, an unreadable tx or undecodable logs", async () => {
    expect(await run(mk({ b: {}, crank: {} }, ["b", "crank"]))).toEqual({ kind: "unknown" });
    expect(await run(mk({}, [], { sigFail: true }))).toEqual({ kind: "unknown" });
    expect(await run(mk({ b: {}, gone: { noMeta: true } }, ["b", "gone"]))).toEqual({ kind: "unknown" });
    expect(await run(mk({ b: {}, bad: { logs: ["Program data: AAAA"] } }, ["b", "bad"]))).toEqual({ kind: "unknown" });
  });
  it("an unreconcilable change counts as a change", async () => {
    const twoAssets = fillEventLogs(WRAPPER, MARKET, [{ ...fillRec(T), executedQ: 0n }], PORTFOLIO);
    const r = await run(mk({ b: {}, odd: { logs: twoAssets } }, ["b", "odd"]));
    expect(r).toEqual({ kind: "sig", sig: "odd" });
  });
  it("stopAt / known.top reached with no change in between returns the record", async () => {
    const c = mk({ b: {}, crank: {}, rec: {}, older: { logs: FILL(T) } }, ["b", "crank", "rec", "older"]);
    expect(await run(c, { stopAt: "rec" })).toEqual({ kind: "sig", sig: "rec" });
    expect(await run(c, { known: { top: "rec", newest: "newestChange" } })).toEqual({ kind: "sig", sig: "newestChange" });
    // a change before the stop wins over it
    const c2 = mk({ b: {}, hit: { logs: FILL(T) }, rec: {} }, ["b", "hit", "rec"]);
    expect(await run(c2, { stopAt: "rec" })).toEqual({ kind: "sig", sig: "hit" });
  });
  it("maxRead reached is unknown; paceMs waits between groups; pages continue", async () => {
    const order = ["b", ...Array.from({ length: 12 }, (_, i) => `c${i}`)];
    const txs: Record<string, Tx> = { b: {} };
    order.slice(1).forEach((s) => (txs[s] = {}));
    const withFill = { ...txs, c7: { logs: FILL(T) } };
    expect(await run(mk(withFill, order), { maxRead: 5 })).toEqual({ kind: "unknown" });
    expect(await run(mk(withFill, order))).toEqual({ kind: "sig", sig: "c7" });
    expect(await run(mk(txs, order), { paceMs: 1 })).toEqual({ kind: "unknown" });
    // page of 2: crossing a page boundary finds the change on page 2
    const o2 = ["b", "c0", "c1", "hit"];
    const t2: Record<string, Tx> = { b: {}, c0: {}, c1: {}, hit: { logs: FILL(T) } };
    expect(await run(mk(t2, o2), { pageSize: 2 })).toEqual({ kind: "sig", sig: "hit" });
  });
});

describe("walletChangeCheck", () => {
  const wrapperIx = (tag: number) => ({ programIdIndex: 0, data: new Uint8Array([tag, 1]) });
  const run = (c: ReturnType<typeof mk>, o: Partial<Parameters<typeof walletChangeCheck>[2]> = {}) => walletChangeCheck(c, WRAPPER, { wallet: WALLET, ...P, recordSig: "rec", ...o });
  const rec = { rec: { slot: 5 } };

  it("unknown when the record's status is missing or has no slot, and on an RPC error", async () => {
    expect(await run(mk({}, [], { statusSlot: null }))).toEqual({ kind: "unknown" });
    expect(await run(mk({}, [], { sigFail: true }))).toEqual({ kind: "unknown" });
    expect(await run(mk({}, []))).toEqual({ kind: "unknown" });
  });
  it("current when nothing between the top and the record changed the position", async () => {
    const c = mk({ crank: { slot: 9 }, ...rec }, ["crank", "rec"]);
    expect(await run(c)).toEqual({ kind: "current" });
    // reached by an older slot instead of the record itself
    expect(await run(mk({ crank: { slot: 9 }, old: { slot: 2 } }, ["crank", "old"]))).toEqual({ kind: "current" });
  });
  it("changed when a wallet transaction in the window moved the position; failed ones and non-wrapper ones are skipped", async () => {
    const c = mk({ failed: { slot: 9, err: {} }, other: { slot: 8, keys: [MARKET] }, hit: { slot: 7, logs: FILL(T) }, ...rec }, ["failed", "other", "hit", "rec"], { batch: true });
    expect(await run(c)).toEqual({ kind: "changed", sig: "hit" });
  });
  it("an unreconcilable fill counts as changed; undecodable logs are unknown; a tx without meta is unknown", async () => {
    const twoAssets = fillEventLogs(WRAPPER, MARKET, [{ ...fillRec(T), executedQ: 0n }], PORTFOLIO);
    expect(await run(mk({ odd: { slot: 9, logs: twoAssets }, ...rec }, ["odd", "rec"]))).toEqual({ kind: "changed", sig: "odd" });
    expect(await run(mk({ bad: { slot: 9, logs: ["Program data: AAAA"] }, ...rec }, ["bad", "rec"]))).toEqual({ kind: "unknown" });
    expect(await run(mk({ gone: { slot: 9, noMeta: true }, ...rec }, ["gone", "rec"]))).toEqual({ kind: "unknown" });
  });
  it("foreign when the window names the NFT program or carries an ownership instruction", async () => {
    expect(await run(mk({ nft: { slot: 9, keys: [NFT] }, ...rec }, ["nft", "rec"]), { nftProgram: NFT })).toEqual({ kind: "foreign", sig: "nft" });
    for (const tag of [72, 82]) {
      const c = mk({ own: { slot: 9, keys: [WRAPPER], ixs: [wrapperIx(tag)] }, ...rec }, ["own", "rec"]);
      expect(await run(c)).toEqual({ kind: "foreign", sig: "own" });
    }
    // a different tag, an empty instruction and a foreign program are not ownership moves
    const c = mk({ t: { slot: 9, keys: [WRAPPER, MARKET], ixs: [wrapperIx(10), { programIdIndex: 0, data: new Uint8Array() }, { programIdIndex: 1, data: new Uint8Array([72]) }] }, ...rec }, ["t", "rec"]);
    expect(await run(c)).toEqual({ kind: "current" });
  });
  it("an unknown message shape cannot rule out an ownership move; a legacy `instructions` list counts as one", async () => {
    // accountKeys only, with a legacy string-data instruction list: cannot be inspected -> foreign
    const legacy = mk({ leg: { slot: 9 }, ...rec }, ["leg", "rec"]);
    const orig = legacy.getTransaction;
    (legacy as unknown as { getTransaction: unknown }).getTransaction = vi.fn(async (sig: string) => {
      const t = await orig.call(legacy, sig, {} as never);
      if (sig !== "leg" || !t) return t;
      return { ...t, transaction: { message: { accountKeys: [WRAPPER], instructions: [{ programIdIndex: 0, data: "abc" }] } } };
    });
    expect(await run(legacy)).toEqual({ kind: "foreign", sig: "leg" });
    // accountKeys with neither instruction form: not ownership
    const none = mk({ n: { slot: 9 }, ...rec }, ["n", "rec"]);
    const o2 = none.getTransaction;
    (none as unknown as { getTransaction: unknown }).getTransaction = vi.fn(async (sig: string) => {
      const t = await o2.call(none, sig, {} as never);
      return sig === "n" && t ? { ...t, transaction: { message: { accountKeys: [WRAPPER] } } } : t;
    });
    expect(await run(none)).toEqual({ kind: "current" });
    // no keys at all on a wrapper-naming tx via loaded addresses: shape unknown -> foreign
    const loaded = mk({ l: { slot: 9, keys: [], loaded: { readonly: [WRAPPER] } }, ...rec }, ["l", "rec"]);
    const o3 = loaded.getTransaction;
    (loaded as unknown as { getTransaction: unknown }).getTransaction = vi.fn(async (sig: string) => {
      const t = await o3.call(loaded, sig, {} as never);
      return sig === "l" && t ? { ...t, transaction: { message: {} } } : t;
    });
    expect(await run(loaded)).toEqual({ kind: "foreign", sig: "l" });
  });
  it("fromSig: not-listed when absent from the first page; the window starts below it; later pages without it are unknown", async () => {
    expect(await run(mk({ a: { slot: 9 }, ...rec }, ["a", "rec"]), { fromSig: "zzz" })).toEqual({ kind: "not-listed" });
    const c = mk({ newer: { slot: 10, logs: FILL(T) }, from: { slot: 9 }, ...rec }, ["newer", "from", "rec"]);
    expect(await run(c, { fromSig: "from" })).toEqual({ kind: "current" });
  });
  it("unknown when the list ends before the record, when too many pages or reads are needed", async () => {
    expect(await run(mk({ a: { slot: 9 } }, ["a"]))).toEqual({ kind: "unknown" });
    const many = Array.from({ length: 1000 }, (_, i) => `s${i}`);
    const txs: Record<string, Tx> = {};
    many.forEach((s) => (txs[s] = { slot: 9 }));
    expect(await run(mk({ ...txs, rec: { slot: 5 } }, [...many, "rec"]), { maxPages: 1 })).toEqual({ kind: "unknown" });
    expect(await run(mk({ ...txs, rec: { slot: 5 } }, [...many, "rec"]), { maxPages: 2, maxRead: 2000 })).toEqual({ kind: "current" });
    // a full page followed by the record: continues to the next page and reads them all
    const order = [...many, "rec"];
    expect(await run(mk({ ...txs, rec: { slot: 5 } }, order), { maxRead: 2000, paceMs: 1 })).toEqual({ kind: "current" });
    expect(await run(mk({ ...txs, rec: { slot: 5 } }, order), { maxRead: 3 })).toEqual({ kind: "unknown" });
    // the second page is empty
    expect(await run(mk(txs, many), { maxPages: 3 })).toEqual({ kind: "unknown" });
  });
});

describe("entryFromChain: limits, resume and memo", () => {
  const go = (c: ReturnType<typeof mk>, qNow: bigint, o: Partial<Parameters<typeof entryFromChain>[2]> = {}) =>
    entryFromChain(c, WRAPPER, { ...P, qNow, baseFeeBps: BASE, mayChargeBusy: false, ...o });
  const memoIx = (n: bigint): { programIdIndex: number; data: Uint8Array } => ({ programIdIndex: 1, data: new TextEncoder().encode(`perc:fb1:${n}`) });

  it("a flat chain position is no-position without any RPC", async () => {
    const c = mk({}, []);
    expect((await go(c, 0n)).verdict).toBe("no-position");
    expect(c.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it("carries the opening memo into positionDeltas and the signed Trade book", async () => {
    const c = mk({ open: { logs: FILL(2n * T), keys: [WRAPPER, MEMO_PROGRAM_ID], ixs: [memoIx(42n)] } }, ["open"]);
    const r = await go(c, 2n * T);
    expect(r.verdict).toBe("chain");
    expect(r.positionDeltas?.[0].fundingBase).toBe(42n);
    expect(bookFromDeltas(r.positionDeltas!, r.startQ!, 2n * T)?.fundingBase).toBe(42n);
  });
  it("an RPC error on the signature list, an empty list, a missing tx, undecodable logs are unreadable / incomplete", async () => {
    expect((await go(mk({}, [], { sigFail: true }), T)).verdict).toBe("unreadable");
    expect((await go(mk({}, []), T)).verdict).toBe("incomplete");
    expect((await go(mk({ g: { noMeta: true } }, ["g"]), T)).verdict).toBe("unreadable");
    expect((await go(mk({ b: { logs: ["Program data: AAAA"] } }, ["b"]), T)).verdict).toBe("unreadable");
  });
  it("an unreconcilable fill is a mismatch", async () => {
    const twoAssets = fillEventLogs(WRAPPER, MARKET, [{ ...fillRec(T), executedQ: 0n }], PORTFOLIO);
    expect((await go(mk({ o: { logs: twoAssets } }, ["o"]), T)).verdict).toBe("mismatch");
  });
  it("skips failed signatures and failed / non-wrapper transactions without counting them", async () => {
    const c = mk({ f1: { err: {} }, f2: { err: null, keys: [MARKET] }, open: { logs: FILL(T) } }, ["f1", "f2", "open"], { batch: true });
    const r = await go(c, T);
    expect(r.verdict).toBe("chain");
    expect(r.changesRead).toBe(1);
  });
  it("incomplete when the history ends without a flat start, and at the read / change limits", async () => {
    const add = (s: string) => ({ [s]: { logs: FILL(T) } });
    // history ends with a single add of 1 while the chain holds 2: never reached flat
    expect((await go(mk({ ...add("a") }, ["a"]), 2n * T)).verdict).toBe("incomplete");
    const order = ["a", "b", "c"];
    const txs = { ...add("a"), ...add("b"), ...add("c") };
    expect((await go(mk(txs, order), 3n * T, { maxTx: 1, concurrency: 1 })).verdict).toBe("incomplete");
    expect((await go(mk(txs, order), 3n * T, { maxRead: 1, concurrency: 1 })).verdict).toBe("incomplete");
    // pacing between groups; paging with a small page size
    const r = await go(mk(txs, order), 3n * T, { concurrency: 1, paceMs: 1, pageSize: 2 });
    expect(r.verdict).toBe("chain");
    expect(r.entry?.fills).toBe(3);
  });
  it("a noBusyCap that throws gives no cap (unexplained entry on a growth market)", async () => {
    const data = new Uint8Array(85);
    data[0] = 10;
    const c = mk({ open: { logs: FILL(T), keys: [WRAPPER], ixs: [{ programIdIndex: 0, data }] } }, ["open"]);
    const r = await go(c, T, { mayChargeBusy: true, noBusyCap: async () => { throw new Error("x"); } });
    expect(r.verdict).toBe("unexplained");
  });
  it("resume: joins a stored walk at the same size, reuses its deltas; a flip in the newer part wins; a mismatch re-walks from scratch", async () => {
    const stored: ChainDelta[] = [{ sig: "old", deltaQ: T, fill: { bookedPriceE6: 100_000_000n, executedQ: T, feeAtoms: 300n, notionalAtoms: 100_000_000n, taker: PORTFOLIO, quotedPriceE6: 0n, legs: 1 } }];
    const c = mk({ add: { logs: FILL(T, 110_000_000n) }, top: {}, old: { logs: FILL(T) } }, ["add", "top", "old"]);
    const r = await go(c, 2n * T, { resume: { topSig: "top", qAtTop: T, startQ: 0n, deltas: stored } });
    expect(r.verdict).toBe("chain");
    expect(r.entry?.fills).toBe(2);
    expect(r.txRead).toBe(1);
    // mismatching qAtTop: starts over (walks the whole list down to the open)
    const c2 = mk({ add: { logs: FILL(T, 110_000_000n) }, top: {}, old: { logs: FILL(T) } }, ["add", "top", "old"]);
    const r2 = await go(c2, 2n * T, { resume: { topSig: "top", qAtTop: 5n * T, startQ: 0n, deltas: stored } });
    expect(r2.verdict).toBe("chain");
    expect(r2.txRead).toBeGreaterThan(1);
    // empty stored deltas: also starts over
    const r3 = await go(mk({ add: { logs: FILL(T, 110_000_000n) }, top: {}, old: { logs: FILL(T) } }, ["add", "top", "old"]), 2n * T, { resume: { topSig: "top", qAtTop: T, startQ: 0n, deltas: [] } });
    expect(r3.verdict).toBe("chain");
    // a newer flip: the position opened (short 1 -> long 1 in one fill of +2) after the stored part
    const flipTx = fillEventLogs(WRAPPER, MARKET, [fillRec(2n * T)], PORTFOLIO);
    const storedShort: ChainDelta[] = [{ sig: "old", deltaQ: -T, fill: { bookedPriceE6: 100_000_000n, executedQ: -T, feeAtoms: 300n, notionalAtoms: 100_000_000n, taker: PORTFOLIO, quotedPriceE6: 0n, legs: 1 } }];
    const r4 = await go(mk({ flip: { logs: flipTx }, top: {}, old: {} }, ["flip", "top", "old"]), T, { resume: { topSig: "top", qAtTop: -T, startQ: 0n, deltas: storedShort } });
    expect(r4.verdict).toBe("chain");
    expect(r4.startQ).toBe(-T);
    expect(r4.entry?.fills).toBe(1);
  });
  it("a REDUCE and a fill in one tx are undone last to first and reported oldest first", async () => {
    const logs = [...FILL(3n * T), ...reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 2, signedReducedQ: -T })];
    const r = await go(mk({ both: { logs } }, ["both"]), 2n * T);
    expect(r.verdict).toBe("chain");
    expect(r.positionDeltas?.map((d) => d.deltaQ)).toEqual([3n * T, -T]);
  });
  it("a REDUCE with a unit we cannot reconcile is a mismatch", async () => {
    const logs = reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 1, signedReducedQ: -T });
    const r = await go(mk({ x: { logs } }, ["x"]), T);
    expect(r.verdict).toBe("mismatch");
  });
});
