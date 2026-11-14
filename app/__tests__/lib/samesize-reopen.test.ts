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
import * as chain from "@/lib/entry-chain";

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
    return list.slice(0, o.limit ?? 1000).map((signature) => ({ signature, slot: 1, err: null, memo: null, blockTime: 0 }));
  }),
  getTransaction: vi.fn(async (s: string) => one(s)),
  getTransactions: vi.fn(async (s: string[]) => s.map(one)),
} as never;

const fillTx = (q: bigint, booked: bigint, memo?: bigint) => ({ logs: fillEventLogs(WRAPPER, MARKET, [rec(q, booked)], PORTFOLIO), ...(memo !== undefined ? { memo } : {}) });
const target = { slab: SLAB, idx: 0, wallet: WALLET, portfolio: PORTFOLIO, wrapper: WRAPPER, qNow: Q };
const row = { slabAddress: SLAB, idx: 0, adlKnown: true, effectiveSize: Q, portfolioPk: PORTFOLIO, entryPriceSource: "cache", account: { positionSize: Q } };

/** Device 1 opens P1 from flat with its own ticket: the measured Entry save and the trade book, as OrderTicket writes them (sig "open1"). */
function device1Opens(): void {
  saveEntryPrice(SLAB, 0, effective(P1), 2, WALLET, Q, { bookedPriceE6: P1, busyFeeAtoms: 0n, lastSig: "open1" } as never);
  recordFill(WALLET, SLAB, PF, { q: Q, bookedPriceE6: P1, feeAtoms: fee(Q, P1), fundingBefore: BASE1, sig: "open1" } as never, 0n);
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
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P2, feeAtoms: fee(Q, P2), funding: { netPaid: BASE2 + 300n, legs: 0 }, sig: "close2" } as never, Q, "open2" as never);
    expect(r).toBeNull();
    expect(loadBook(WALLET, SLAB, PF)).toBeNull();
  });

  it("a close on device 1 after the check: the Trade result is P2's exact result (fees of open2 + close, funding 300)", async () => {
    device1Opens();
    await syncChainEntry(conn, target, () => 10_000_000);
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P2, feeAtoms: fee(Q, P2), funding: { netPaid: BASE2 + 300n, legs: 0 }, sig: "close2" } as never, Q, "open2" as never);
    expect(r).toBe(0n - 2n * fee(Q, P2) - 300n);
  });

  it("the newest position change before a fill is found from chain, skipping cranks", async () => {
    order = ["close2", "k5", "k4", "open2", "k3", "close1", "k2", "k1", "k0", "open1"];
    txs.close2 = fillTx(-Q, P2);
    const prev = await (chain as unknown as { prevChangeSig: (...a: unknown[]) => Promise<unknown> }).prevChangeSig?.(conn, WRAPPER, { market: MARKET, portfolio: PORTFOLIO, beforeSig: "close2" });
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
    const r = recordFill(WALLET, SLAB, PF, { q: -Q, bookedPriceE6: P1, feeAtoms: fee(Q, P1), funding: { netPaid: BASE1 + 50n, legs: 0 }, sig: "close1" } as never, Q, "open1" as never);
    expect(r).toBe(0n - 2n * fee(Q, P1) - 50n);
  });
});
