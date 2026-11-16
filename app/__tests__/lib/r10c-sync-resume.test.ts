/** Council r10 recheck D1/D6 at the sync level: the real walk, stored between rebuilds; a later rebuild reads only what is new; the book is stored. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fillEventLogs } from "../helpers/fill-event-fixture";

const h = vi.hoisted(() => ({ nowQ: 0n }));
vi.mock("@/lib/v21/growth-market", () => ({ growthRecordPresence: () => "absent" }));
vi.mock("@/lib/limits/trade-fee-resolve", () => ({ resolveTradeFeeBps: () => ({ feeBps: 135n, maxFeeBps: 700n }) }));
vi.mock("@/lib/position-change", () => ({ readEffectivePositionQ: async () => h.nowQ }));
vi.mock("@/lib/limits/decode", () => ({ decodeMarketEngineView: () => ({ tradeFeeBaseBps: 30n }) }));

import { VERIFY_MS, __resetEntryChainSyncForTests, syncChainEntry } from "@/lib/entry-chain-sync";
import { getSavedEntry } from "@/lib/entry-price";
import { loadBookByWallet } from "@/lib/trade-book";
import { MEMO_PROGRAM_ID, fundingMemoIx } from "@/lib/funding-memo";

const WRAPPER = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const PORTFOLIO = Keypair.generate().publicKey;
const WALLET = Keypair.generate().publicKey.toBase58();
const T = 1_000_000n;
const W = WRAPPER.toBase58();
const CRANK = [`Program ${W} invoke [1]`, `Program ${W} success`];
const rec = (q: bigint, booked: bigint) => {
  const n = ((q < 0n ? -q : q) * booked) / 1_000_000n;
  return { flags: 8, requestedQ: q, executedQ: q, priceE6: booked, quotedPriceE6: q > 0n ? booked + (booked * 23n) / 10_000n : booked - (booked * 23n) / 10_000n, feeAtoms: (n * 53n) / 10_000n };
};

const txs: Record<string, { logs: string[]; memo?: bigint }> = {};
let order: string[] = [];
const reads: string[] = [];
const one = (sig: string) => {
  reads.push(sig);
  const t = txs[sig];
  const keys = t.memo !== undefined ? [WRAPPER, MEMO_PROGRAM_ID] : [WRAPPER];
  const ixs = t.memo !== undefined ? [{ programIdIndex: 1, data: new Uint8Array(fundingMemoIx(t.memo).data) }] : [];
  return { slot: 1, meta: { err: null, logMessages: t.logs }, transaction: { message: { staticAccountKeys: keys, compiledInstructions: ixs } } };
};
const conn = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })),
  getSignaturesForAddress: vi.fn(async (_pk: PublicKey, o: { limit?: number; before?: string }) => {
    const start = o.before ? order.indexOf(o.before) + 1 : 0;
    return order.slice(start, start + (o.limit ?? 1000)).map((signature) => ({ signature, slot: 1, err: null, memo: null, blockTime: 0 }));
  }),
  getTransaction: vi.fn(async (s: string) => one(s)),
  getTransactions: vi.fn(async (s: string[]) => s.map(one)),
} as never;

beforeEach(() => {
  localStorage.clear();
  __resetEntryChainSyncForTests();
  reads.length = 0;
});

describe("syncChainEntry with the real walk", () => {
  it("device 2: Entry and the funding book from chain; after a partial close elsewhere, the next rebuild reads only the new transactions", async () => {
    txs.open = { logs: fillEventLogs(WRAPPER, MARKET, [rec(2n * T, 100_000_000n)], PORTFOLIO), memo: 415_917n };
    for (let i = 0; i < 9; i++) txs[`k${i}`] = { logs: CRANK };
    order = ["k8", "k7", "k6", "k5", "k4", "k3", "k2", "k1", "k0", "open"];
    h.nowQ = 2n * T;
    let now = 1_000_000;
    const t = (q: bigint) => ({ slab: MARKET.toBase58(), idx: 0, wallet: WALLET, portfolio: PORTFOLIO, wrapper: WRAPPER, qNow: q });
    expect(await syncChainEntry(conn, t(2n * T), () => now)).toBe("chain");
    expect(getSavedEntry(MARKET.toBase58(), 0, WALLET)?.entryPriceE6).toBe(100_230_000n);
    expect(loadBookByWallet(WALLET, MARKET.toBase58())).toMatchObject({ q: 2n * T, fundingBase: 415_917n });
    expect(reads).toHaveLength(10);

    // device 1 half-closes; two more cranks
    txs.part = { logs: fillEventLogs(WRAPPER, MARKET, [rec(-T, 101_000_000n)], PORTFOLIO) };
    txs.k9 = { logs: CRANK };
    txs.k10 = { logs: CRANK };
    order = ["k10", "part", "k9", ...order];
    h.nowQ = T;
    reads.length = 0;
    now += VERIFY_MS + 1;
    expect(await syncChainEntry(conn, t(T), () => now)).toBe("chain");
    expect(reads).toEqual(["k10", "part", "k9"]); // only what is new since the stored top
    expect(getSavedEntry(MARKET.toBase58(), 0, WALLET)).toMatchObject({ entryPriceE6: 100_230_000n, sizeQ: T });
    expect(loadBookByWallet(WALLET, MARKET.toBase58())).toMatchObject({ q: T, fundingBase: 415_917n });
  });
});
