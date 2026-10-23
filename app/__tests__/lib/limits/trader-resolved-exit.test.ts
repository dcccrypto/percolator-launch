/** Trader exit from a Resolved market: the pre-signed list, what is still needed, and the driver (AUD-FC-A2). */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  TRADER_CLOSE_COPIES,
  TRADER_EXIT_MAX_TXS,
  TRADER_TOPUP_COPIES,
  runTraderExit,
  traderExitItems,
  traderItemNeeded,
  type TraderExitItem,
} from "@/lib/limits/trader-resolved-exit";
import type { ResolvedPortfolioView } from "@/lib/limits/decode";
import type { OwnPortfolio } from "@/lib/limits/own-portfolio-cleanup";

const view = (o: Partial<ResolvedPortfolioView> = {}): ResolvedPortfolioView => ({
  owner: new Uint8Array(32), capital: 1_000_000n, pnl: 0n, reservedPnl: 0n, feeCredits: 0n, cancelDepositEscrow: 0n, activeBitmap: 1n,
  stale: false, bStale: false, rebalanceLock: false, liquidationLock: false, receiptPresent: false, receiptFinalized: false, ...o,
});
const EMPTY = view({ capital: 0n, activeBitmap: 0n });
const own = (v: ResolvedPortfolioView): OwnPortfolio => ({ key: Keypair.generate().publicKey, view: v, portfolioId: 1n, matcherSequence: 0n, positionEpoch: 0n });

describe("traderExitItems", () => {
  it("a live portfolio: 12 x CloseResolved, 2 x top-up, 2 x CloseResolved, 1 x top-up, then ClosePortfolio", () => {
    const p = own(view());
    const items = traderExitItems([p]);
    const k = p.key.toBase58();
    expect(items.filter((i) => i.kind === "close-resolved")).toHaveLength(TRADER_CLOSE_COPIES + 2);
    expect(items.filter((i) => i.kind === "claim-topup")).toHaveLength(TRADER_TOPUP_COPIES + 1);
    expect(items.at(-1)).toEqual({ kind: "close-empty", portfolio: k, copy: 0 });
    expect(items.every((i) => i.portfolio === k)).toBe(true);
    expect(new Set(items.map((i) => `${i.kind}#${i.copy}`)).size).toBe(items.length); // distinct copies (distinct signatures)
    expect(items.map((i) => i.kind).slice(0, TRADER_CLOSE_COPIES).every((x) => x === "close-resolved")).toBe(true);
  });
  it("an already-empty portfolio only needs the close; locked / mid-liquidation ones are skipped", () => {
    const e = own(EMPTY);
    expect(traderExitItems([e])).toEqual([{ kind: "close-empty", portfolio: e.key.toBase58(), copy: 0 }]);
    expect(traderExitItems([own(view({ liquidationLock: true })), own(view({ rebalanceLock: true }))])).toEqual([]);
  });
  it("never more than the cap, every portfolio keeps at least one close and one 8", () => {
    const many = Array.from({ length: 6 }, () => own(view()));
    const items = traderExitItems(many);
    expect(items.length).toBeLessThanOrEqual(TRADER_EXIT_MAX_TXS);
    expect(traderExitItems([own(view())]).length).toBeLessThanOrEqual(TRADER_EXIT_MAX_TXS);
  });
});

describe("traderItemNeeded", () => {
  const mk = (kind: TraderExitItem["kind"]): TraderExitItem => ({ kind, portfolio: "p", copy: 0 });
  const open = view({ receiptPresent: true, receiptFinalized: false });
  it("matrix", () => {
    expect([traderItemNeeded(mk("close-resolved"), view()), traderItemNeeded(mk("close-resolved"), EMPTY), traderItemNeeded(mk("close-resolved"), open), traderItemNeeded(mk("close-resolved"), null)]).toEqual([true, false, false, false]);
    expect([traderItemNeeded(mk("claim-topup"), open), traderItemNeeded(mk("claim-topup"), view()), traderItemNeeded(mk("claim-topup"), null)]).toEqual([true, false, false]);
    expect([traderItemNeeded(mk("close-empty"), EMPTY), traderItemNeeded(mk("close-empty"), view()), traderItemNeeded(mk("close-empty"), null)]).toEqual([true, false, false]);
  });
});

describe("runTraderExit", () => {
  /** A fake chain: each CloseResolved removes one chunk; after `chunks` the portfolio is empty; ClosePortfolio deletes it. */
  function chain(chunks: number, opts: { receiptAfter?: number } = {}) {
    const p = own(view());
    const key = p.key.toBase58();
    let left = chunks;
    let closed = false;
    let receipt = false;
    const sent: string[] = [];
    const items = traderExitItems([p]);
    const txs = items.map((item, i) => ({ item, tx: `${item.kind}#${i}` }));
    const read = async () => new Map<string, ResolvedPortfolioView | null>([[key, closed ? null : left > 0 ? view({ receiptPresent: receipt, receiptFinalized: false }) : EMPTY]]);
    const broadcast = async (tx: string) => {
      sent.push(tx);
      if (tx.startsWith("close-resolved")) {
        left -= 1;
        if (opts.receiptAfter !== undefined && chunks - left === opts.receiptAfter) receipt = true;
      } else if (tx.startsWith("claim-topup")) {
        receipt = false;
        left -= 1;
      } else if (tx.startsWith("close-empty")) closed = true;
      return tx;
    };
    return { txs, read, broadcast, sent };
  }

  it("a 3-chunk portfolio: exactly 3 closes and the 8 are broadcast; the other 9 copies are skipped, never sent", async () => {
    const c = chain(3);
    const r = await runTraderExit(c.txs, { read: c.read, broadcast: c.broadcast });
    expect(c.sent.filter((t) => t.startsWith("close-resolved"))).toHaveLength(3);
    expect(c.sent.filter((t) => t.startsWith("claim-topup"))).toHaveLength(0);
    expect(c.sent.filter((t) => t.startsWith("close-empty"))).toHaveLength(1);
    expect(r.broadcast).toBe(4);
    expect(r.skipped).toBe(c.txs.length - 4);
    expect(r.remaining).toEqual([]);
    expect(r.stale).toBe(false);
  });

  it("the worst case in the E2E pass (12 chunks) fits the copies", async () => {
    const c = chain(12);
    const r = await runTraderExit(c.txs, { read: c.read, broadcast: c.broadcast });
    expect(r.remaining).toEqual([]);
    expect(c.sent.filter((t) => t.startsWith("close-resolved"))).toHaveLength(12);
  });

  it("a payout receipt opening mid-way switches to the 46 top-up, then the 8", async () => {
    const c = chain(3, { receiptAfter: 1 });
    const r = await runTraderExit(c.txs, { read: c.read, broadcast: c.broadcast });
    expect(c.sent.some((t) => t.startsWith("claim-topup"))).toBe(true);
    expect(r.remaining).toEqual([]);
  });

  it("a failed copy does not stop the later steps; an expired blockhash does", async () => {
    const c = chain(2);
    let n = 0;
    const flaky = async (tx: string) => {
      if (++n === 1) throw new Error("custom program error: 0x1");
      return c.broadcast(tx);
    };
    const r = await runTraderExit(c.txs, { read: c.read, broadcast: flaky });
    expect(r.failed).toBe(1);
    expect(r.remaining).toEqual([]);
    const c2 = chain(2);
    const r2 = await runTraderExit(c2.txs, { read: c2.read, broadcast: async () => { throw new Error("Blockhash not found"); } });
    expect(r2.stale).toBe(true);
    expect(r2.broadcast).toBe(0);
    expect(r2.remaining).toHaveLength(1);
  });

  it("nothing is sent for a portfolio that is already gone", async () => {
    const c = chain(2);
    const r = await runTraderExit(c.txs, { read: async () => new Map(), broadcast: c.broadcast });
    expect(c.sent).toEqual([]);
    expect(r.skipped).toBe(c.txs.length);
  });
});
