/** r10 owner decision 6: the Entry rebuilt from on-chain fills (partial close, flip, add, bounds, honest unknowns). */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fillEventLogs, reduceEventLogs } from "../helpers/fill-event-fixture";
import { chainFillPrice, entryFromChain, rebuildEntry, signedFeeBpsFromTx, signedFeeFromTx, type ChainDelta } from "@/lib/entry-chain";
import { effectivePriceE6, type ExecFill } from "@/lib/v22/exec-fill";

const WRAPPER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const OTHER = Keypair.generate().publicKey;
const T = 1_000_000n; // 1 token in engine units
const BASE = 30n; // base fee bps

/** A fill the way the chain books it: fee = base 30 bps + the matcher's spread (quoted vs booked) on the notional (+ an optional busy fee). */
function rec(q: bigint, booked: bigint, spreadBps: bigint, busyBps = 0n) {
  const notional = (abs(q) * booked) / 1_000_000n;
  const quoted = q > 0n ? booked + (booked * spreadBps) / 10_000n : booked - (booked * spreadBps) / 10_000n;
  const fee = (notional * (BASE + spreadBps + busyBps)) / 10_000n;
  return { flags: 8, requestedQ: q, executedQ: q, priceE6: booked, quotedPriceE6: quoted, feeAtoms: fee };
}
const abs = (n: bigint) => (n < 0n ? -n : n);
const effective = (q: bigint, booked: bigint, spreadBps: bigint) => (q > 0n ? booked + (booked * spreadBps) / 10_000n : booked - (booked * spreadBps) / 10_000n);

type Tx = { logs: string[]; err?: unknown; signed?: bigint };
// a wrapper-free transaction (a deposit, a crank): well-formed logs, no event
const NOISE = ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"];
/** TradeCpi instruction data (85 bytes): tag 10, asset u16 @41, fee_bps u64 @67. */
function tradeCpiData(feeBps: bigint, asset = 0): Uint8Array {
  const b = Buffer.alloc(85);
  b[0] = 10;
  b.writeUInt16LE(asset, 41);
  b.writeBigUInt64LE(feeBps, 67);
  return new Uint8Array(b);
}

function conn(txs: Record<string, Tx>, order: string[], opt: { failSigs?: boolean; failTx?: string } = {}) {
  const getSignaturesForAddress = vi.fn(async (_pk: PublicKey, o: { limit?: number; before?: string }) => {
    if (opt.failSigs) throw new Error("429");
    const start = o.before ? order.indexOf(o.before) + 1 : 0;
    return order.slice(start, start + (o.limit ?? 1000)).map((signature) => ({ signature, slot: 1, err: txs[signature].err ?? null, memo: null, blockTime: 0 }));
  });
  const getTransaction = vi.fn(async (sig: string) => {
    if (opt.failTx === sig) throw new Error("rpc");
    const signed = txs[sig].signed;
    return {
      slot: 1,
      meta: { err: txs[sig].err ?? null, logMessages: txs[sig].logs },
      transaction: { message: signed === undefined ? { staticAccountKeys: [], compiledInstructions: [] } : { staticAccountKeys: [WRAPPER], compiledInstructions: [{ programIdIndex: 0, data: tradeCpiData(signed) }] } },
    };
  });
  return { getSignaturesForAddress, getTransaction } as unknown as Parameters<typeof entryFromChain>[0] & { getSignaturesForAddress: typeof getSignaturesForAddress; getTransaction: typeof getTransaction };
}
/**
 * Real devnet values: every v2.2 order on a base-30 / max-700 growth market signs base + the matcher's worst-case fee (100) + the SDK margin (5) = 135 when
 * no busy rate is quoted (27o3fM4W, xtzhMZti, 4END5Rd7, 5G45QjYy all signed 135); the r9 forced-1x busy Max 41mFjKK6 signed 633.
 */
const SIGNED_NO_BUSY = 135n;
const CAP = { feeBps: 135n, maxFeeBps: 700n };
/** `room`: extra bps of busy room the order signed on top of the no-busy cap. */
const fill = (q: bigint, booked: bigint, spread: bigint, busy = 0n, taker = PORTFOLIO, room = 0n): Tx => ({ logs: fillEventLogs(WRAPPER, MARKET, [rec(q, booked, spread, busy)], taker), signed: SIGNED_NO_BUSY + room });
const run = (c: ReturnType<typeof conn>, qNow: bigint, o: Partial<Parameters<typeof entryFromChain>[2]> = {}) =>
  entryFromChain(c, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, qNow, baseFeeBps: BASE, noBusyCap: async () => CAP, ...o });

describe("entryFromChain: open, add, partial close, flip", () => {
  it("a single open: the entry is the price paid (booked + fee-base spread); no busy part", async () => {
    const c = conn({ s1: fill(2n * T, 100_000_000n, 23n) }, ["s1"]);
    const r = await run(c, 2n * T);
    expect(r.verdict).toBe("chain");
    expect(r.entry?.entryPriceE6).toBe(effective(2n * T, 100_000_000n, 23n));
    expect(r.entry?.bookedPriceE6).toBe(100_000_000n);
    expect(r.entry?.busyFeeAtoms).toBe(0n);
  });
  it("DECISION 2: an open with a busy-side part above rounding is UNKNOWN on a growth market (the chain cannot prove the rate), and priced from fee - base on a non-growth one", async () => {
    const c = conn({ s1: fill(2n * T, 100_000_000n, 23n, 200n) }, ["s1"]);
    const g = await run(c, 2n * T, { mayChargeBusy: true });
    expect(g.verdict).toBe("unexplained");
    expect(g.entry).toBeNull();
    // non-growth: no busy fee exists; the whole excess is spread, exactly as the ticket (busyFeeBps null) computes it
    const ng = await run(conn({ s1: fill(2n * T, 100_000_000n, 23n, 200n) }, ["s1"]), 2n * T, { mayChargeBusy: false });
    expect(ng.verdict).toBe("chain");
    expect(ng.entry?.busyFeeAtoms).toBe(0n);
    expect(ng.entry?.entryPriceE6).toBe(effective(2n * T, 100_000_000n, 223n));
  });
  it("an add averages by size; a PARTIAL close keeps the average (the case the device cache lost)", async () => {
    const txs = { s1: fill(T, 100_000_000n, 20n), s2: fill(T, 110_000_000n, 20n), s3: fill(-T, 120_000_000n, 20n) };
    const r = await run(conn(txs, ["s3", "s2", "s1"]), T);
    expect(r.verdict).toBe("chain");
    const e1 = effective(T, 100_000_000n, 20n);
    const e2 = effective(T, 110_000_000n, 20n);
    expect(r.entry?.entryPriceE6).toBe((e1 + e2) / 2n);
    expect(r.entry?.sizeQ).toBe(T);
  });
  it("only the CURRENT trade is used: an earlier, closed trade before the flat point is never read into it", async () => {
    const c = conn({ s0: fill(5n * T, 50_000_000n, 20n), s1: fill(-5n * T, 60_000_000n, 20n), s2: fill(T, 100_000_000n, 20n) }, ["s2", "s1", "s0"]);
    const r = await run(c, T, { concurrency: 1 });
    expect(r.entry?.entryPriceE6).toBe(effective(T, 100_000_000n, 20n));
    expect(c.getTransaction).toHaveBeenCalledTimes(1); // s2 reaches flat: s1 and s0 are never fetched (a group may over-read by up to `concurrency - 1`)
  });
  it("a FLIP is only accepted once the EARLIER trade also unwinds to flat exactly (so silent ADL scaling cannot fake a flip)", async () => {
    // short 1 opened, then buy 3 flips to long 2: the walk reads past the flip to the short's open
    const txs = { s0: fill(-T, 100_000_000n, 20n), s1: fill(3n * T, 105_000_000n, 20n) };
    const ok = await run(conn(txs, ["s1", "s0"]), 2n * T);
    expect(ok.verdict).toBe("chain");
    expect(ok.entry?.entryPriceE6).toBe(effective(3n * T, 105_000_000n, 20n));
    // the same fills but the chain holds 1.9: the unwind lands on -0.1, never on flat
    const bad = await run(conn(txs, ["s1", "s0"]), 1_900_000n);
    expect(bad.verdict).toBe("incomplete");
    expect(bad.entry).toBeNull();
  });
  it("a FLIP: only the opening half belongs to the new position", async () => {
    // long 1, then a single sell of 3 flips to short 2
    const txs = { s1: fill(T, 100_000_000n, 20n), s2: fill(-3n * T, 105_000_000n, 20n) };
    const r = await run(conn(txs, ["s2", "s1"]), -2n * T);
    expect(r.verdict).toBe("chain");
    expect(r.entry?.entryPriceE6).toBe(effective(-3n * T, 105_000_000n, 20n));
    expect(r.entry?.sizeQ).toBe(-2n * T);
  });
  it("a short, and unrelated transactions in the list (deposits, other markets, other portfolios' fills) are ignored", async () => {
    const txs = {
      a: { logs: ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"] },
      b: fill(-2n * T, 80_000_000n, 25n),
      c: fill(T, 90_000_000n, 10n, 0n, OTHER),
    };
    const r = await run(conn(txs, ["a", "c", "b"]), -2n * T);
    expect(r.verdict).toBe("chain");
    expect(r.entry?.entryPriceE6).toBe(effective(-2n * T, 80_000_000n, 25n));
  });
  it("a failed transaction on the list changes nothing", async () => {
    const txs = { f: { logs: [], err: { InstructionError: [0, 1] } }, s1: fill(T, 100_000_000n, 20n) };
    const r = await run(conn(txs, ["f", "s1"]), T);
    expect(r.verdict).toBe("chain");
  });
  it("a REDUCE in effective units (a partial liquidation) shrinks the size and keeps the average", async () => {
    const txs = { s1: fill(4n * T, 100_000_000n, 20n), s2: { logs: reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 3, signedReducedQ: -T }) } };
    const r = await run(conn(txs, ["s2", "s1"]), 3n * T);
    expect(r.verdict).toBe("chain");
    expect(r.entry?.entryPriceE6).toBe(effective(4n * T, 100_000_000n, 20n));
  });
});

describe("entryFromChain: honest unknowns (the device cache is then left as it was)", () => {
  it("the RPC fails: unreadable", async () => {
    expect((await run(conn({}, [], { failSigs: true }), T)).verdict).toBe("unreadable");
    expect((await run(conn({ s1: fill(T, 100_000_000n, 20n) }, ["s1"], { failTx: "s1" }), T)).verdict).toBe("unreadable");
  });
  it("the transaction limit is reached before the open: incomplete, and it stops reading (bounded RPC)", async () => {
    const txs: Record<string, Tx> = {};
    const order: string[] = [];
    for (let i = 0; i < 40; i++) { txs[`n${i}`] = { logs: NOISE }; order.push(`n${i}`); }
    txs.open = fill(T, 100_000_000n, 20n);
    order.push("open");
    const c = conn(txs, order);
    const r = await run(c, T, { maxTx: 12, pageSize: 10 });
    expect(r.verdict).toBe("incomplete");
    expect(c.getTransaction.mock.calls.length).toBeLessThanOrEqual(12);
    expect(c.getSignaturesForAddress.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("the history ends without a flat start: incomplete", async () => {
    expect((await run(conn({ s1: fill(T, 100_000_000n, 20n) }, ["s1"]), 3n * T)).verdict).toBe("incomplete");
  });
  it("the fills do not add up to the position (e.g. silent ADL scaling): mismatch, never a guess", async () => {
    const c = conn({ s1: fill(3n * T, 100_000_000n, 20n), s2: fill(-T, 100_000_000n, 20n) }, ["s2", "s1"]);
    // chain holds 1.9 not 2: the walk never lands on flat exactly, so it runs out of history
    const r = await run(c, 1_900_000n);
    expect(["incomplete", "mismatch"]).toContain(r.verdict);
    expect(r.entry).toBeNull();
  });
  it("a REDUCE whose unit cannot be reconciled (basis units): mismatch", async () => {
    const txs = { s1: fill(4n * T, 100_000_000n, 20n), s2: { logs: reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 1, signedReducedQ: -T }) } };
    expect((await run(conn(txs, ["s2", "s1"]), 3n * T)).verdict).toBe("mismatch");
  });
  it("a truncated log is unreadable, never 'no fill'", async () => {
    const logs = [...fill(T, 100_000_000n, 20n).logs, "Log truncated"];
    expect((await run(conn({ s1: { logs } }, ["s1"]), T)).verdict).toBe("unreadable");
  });
  it("a flat position: no-position, no RPC", async () => {
    const c = conn({}, []);
    expect((await run(c, 0n)).verdict).toBe("no-position");
    expect(c.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});

describe("chainFillPrice: the same arithmetic as the ticket, and the r9 'unknown' rule on growth markets", () => {
  // The real devnet fill 27o3fM4W: booked 89.535739, fee 106,043 on 20.0088 USDC (30 bps base + 23 spread), quoted 89.741672 (request ceil 24 bps).
  const real: ExecFill = { bookedPriceE6: 89_535_739n, executedQ: 223_463n, feeAtoms: 106_043n, notionalAtoms: 20_008_889n, taker: PORTFOLIO, quotedPriceE6: 89_741_672n, legs: 1 };
  const NO_BUSY_SIGNED = 135n; // what a real v2.2 order with no busy rate signs on this market (27o3fM4W)
  const CAP_135 = { feeBps: 135n, maxFeeBps: 700n };
  it("equals effectivePriceE6 (the ticket) bit for bit on the real fill, growth or not", () => {
    const ticket = effectivePriceE6(real, 30n, null);
    expect(ticket).not.toBeNull();
    expect(chainFillPrice(real, 30n, false)?.priceE6).toBe(ticket);
    expect(chainFillPrice(real, 30n, true, NO_BUSY_SIGNED, CAP_135)?.priceE6).toBe(ticket);
    expect(chainFillPrice(real, 30n, true, NO_BUSY_SIGNED, CAP_135)?.priceE6).toBe(effectivePriceE6(real, 30n, 0n));
  });
  it("the real fill with 5 bps charged and 3 bps quoted: UNKNOWN on a growth market (the ticket's r9 case), a number only where no busy fee exists", () => {
    const f = { ...real, feeAtoms: real.feeAtoms + (real.notionalAtoms * 5n) / 10_000n };
    expect(effectivePriceE6(f, 30n, 3n)).toBeNull(); // the trading device: unknown
    expect(chainFillPrice(f, 30n, true, NO_BUSY_SIGNED + 3n, CAP_135)).toBeNull(); // the other device: also unknown
    expect(chainFillPrice(f, 30n, false)?.priceE6).toBe(effectivePriceE6(f, 30n, null)); // non-growth: spread = fee - base, as the ticket
  });
  it("N1: quoted 3 bps, charged 0 (utilisation fell before landing): the ticket is unknown; the chain sees room in the SIGNED fee_bps and is unknown too", () => {
    expect(effectivePriceE6(real, 30n, 3n)).toBeNull(); // device 1: unknown
    expect(chainFillPrice(real, 30n, true, NO_BUSY_SIGNED + 3n, CAP_135)).toBeNull(); // the order signed room for the 3 bps rate
    expect(chainFillPrice(real, 30n, true, NO_BUSY_SIGNED + 1n, CAP_135)).toBeNull(); // any room above the default margin
  });
  it("N1: a raised-fee (Custom 98) order that landed with no busy part: unknown", () => {
    expect(chainFillPrice(real, 30n, true, 700n, CAP_135)).toBeNull();
  });
  it("N1: no signed fee provable (batch, unreadable instruction) on a growth market: unknown; non-growth does not need it", () => {
    expect(chainFillPrice(real, 30n, true, null, CAP_135)).toBeNull();
    expect(chainFillPrice(real, 30n, false, null)?.priceE6).toBe(effectivePriceE6(real, 30n, null));
  });
  it("D1: the r9 busy Max 41mFjKK6 signed 633: unknown even with a fee that is base + request (isolates the signed check); and signed 135 is the proven no-busy case", () => {
    expect(chainFillPrice(real, 30n, true, 633n, CAP_135)).toBeNull();
    expect(chainFillPrice(real, 30n, true, 135n, CAP_135)).not.toBeNull();
  });
  it("D1: signed below the cap (config changed / fallback), a cap that cannot be read, and a signed value at the market maximum are all unknown", () => {
    expect(chainFillPrice(real, 30n, true, 134n, CAP_135)).toBeNull();
    expect(chainFillPrice(real, 30n, true, 135n, null)).toBeNull();
    expect(chainFillPrice(real, 30n, true, 700n, { feeBps: 700n, maxFeeBps: 700n })).toBeNull();
  });
  it("NEGATIVE: a fee below base + the matcher's own request is not explained on a growth market", () => {
    expect(chainFillPrice({ ...real, feeAtoms: 80_000n }, 30n, true, NO_BUSY_SIGNED, CAP_135)).toBeNull();
  });
});

describe("signedFeeBpsFromTx", () => {
  const msg = (...ixs: { programIdIndex: number; data: Uint8Array }[]) => ({ staticAccountKeys: [WRAPPER, OTHER], compiledInstructions: ixs });
  it("reads fee_bps of the one TradeCpi for the asset; none, several, another program, another asset or a short body = null", () => {
    const ok = { programIdIndex: 0, data: tradeCpiData(56n) };
    expect(signedFeeBpsFromTx(msg(ok), WRAPPER, 0)).toBe(56n);
    expect(signedFeeBpsFromTx(msg(), WRAPPER, 0)).toBeNull();
    expect(signedFeeBpsFromTx(msg(ok, ok), WRAPPER, 0)).toBeNull();
    expect(signedFeeBpsFromTx(msg({ programIdIndex: 1, data: tradeCpiData(56n) }), WRAPPER, 0)).toBeNull();
    expect(signedFeeBpsFromTx(msg({ programIdIndex: 0, data: tradeCpiData(56n, 3) }), WRAPPER, 0)).toBeNull();
    expect(signedFeeBpsFromTx(msg({ programIdIndex: 0, data: new Uint8Array([10, 1, 2]) }), WRAPPER, 0)).toBeNull();
    expect(signedFeeBpsFromTx(null, WRAPPER, 0)).toBeNull();
  });
  it("the matcher context is account 5 of the instruction", async () => {
    const ctx = Keypair.generate().publicKey;
    const keys = [WRAPPER, ctx, OTHER];
    const got = signedFeeFromTx({ staticAccountKeys: keys, compiledInstructions: [{ programIdIndex: 0, data: tradeCpiData(135n), accountKeyIndexes: [2, 2, 2, 2, 2, 1, 2] }] }, WRAPPER, 0);
    expect(got?.feeBps).toBe(135n);
    expect(got?.matcherCtx?.equals(ctx)).toBe(true);
  });
  it("end to end: an order that signed room for a busy rate gives an unknown Entry on a growth market even though no busy fee was charged", async () => {
    const room = await run(conn({ s1: fill(2n * T, 100_000_000n, 23n, 0n, PORTFOLIO, 3n) }, ["s1"]), 2n * T);
    expect(room.verdict).toBe("unexplained");
    const none = await run(conn({ s1: fill(2n * T, 100_000_000n, 23n) }, ["s1"]), 2n * T);
    expect(none.verdict).toBe("chain");
    const nonGrowth = await run(conn({ s1: fill(2n * T, 100_000_000n, 23n, 0n, PORTFOLIO, 3n) }, ["s1"]), 2n * T, { mayChargeBusy: false });
    expect(nonGrowth.verdict).toBe("chain");
  });
});

describe("decoder-skipped events and log order", () => {
  it("a transaction whose logs hold an event the decoder skipped (unknown REDUCE reason) is unreadable, never 'no change'", async () => {
    const txs = { s1: { logs: reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 99, signedReducedQ: -T }) } };
    expect((await run(conn(txs, ["s1"]), T)).verdict).toBe("unreadable");
  });
  it("log order changes the answer: an add then a REDUCE (liquidation) in one transaction keeps the added average; the reverse order would restart it", async () => {
    // s0: long 1 @100. s1 logs: FILL +3 @110, then REDUCE -1 (effective units). Fill first: (1x100 + 3x110)/4 kept; reduce first would flat the 1 and reopen at 110.
    const f = fill(3n * T, 110_000_000n, 20n).logs;
    const r = reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 3, signedReducedQ: -T });
    const logs = [...f.slice(0, 2), ...r.slice(1, 2), f[2]];
    const s1: Tx = { logs, signed: SIGNED_NO_BUSY };
    const out = await run(conn({ s0: fill(T, 100_000_000n, 20n), s1 }, ["s1", "s0"]), 3n * T);
    expect(out.verdict).toBe("chain");
    expect(out.entry?.entryPriceE6).toBe((effective(T, 100_000_000n, 20n) + 3n * effective(3n * T, 110_000_000n, 20n)) / 4n);
  });
  it("a REDUCE logged AFTER the fill in one transaction is applied after it", async () => {
    const f = fill(4n * T, 100_000_000n, 20n).logs;
    const r = reduceEventLogs(WRAPPER, MARKET, PORTFOLIO, { reason: 3, signedReducedQ: -T });
    // one transaction: fill frame then reduce frame
    const logs = [...f.slice(0, 2), ...r.slice(1, 2), f[2]];
    const out = await run(conn({ s1: { logs, signed: SIGNED_NO_BUSY } }, ["s1"]), 3n * T);
    expect(out.verdict).toBe("chain");
    expect(out.entry?.sizeQ).toBe(3n * T);
  });
});

describe("rebuildEntry: pure", () => {
  it("needs the changes to end at the chain's size", () => {
    const d: ChainDelta = { sig: "s", deltaQ: T, signedFeeBps: 135n, noBusyCap: { feeBps: 135n, maxFeeBps: 700n }, fill: { bookedPriceE6: 100_000_000n, executedQ: T, feeAtoms: 300_000n, notionalAtoms: 100_000_000n, taker: PORTFOLIO, quotedPriceE6: 100_000_000n, legs: 1 } };
    expect(rebuildEntry([d], 2n * T, BASE).verdict).toBe("mismatch");
    expect(rebuildEntry([d], T, BASE).verdict).toBe("chain");
  });
});
