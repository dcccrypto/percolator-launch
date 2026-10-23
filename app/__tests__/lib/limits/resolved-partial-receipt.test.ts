// @vitest-environment node
/**
 * P3 ordering: a trader whose CloseResolved (30) ran while another claim was still unreceipted
 * (the vault LP's before its 101, or another trader's) holds a PARTIAL payout receipt; the rest
 * arrives via the permissionless tag-46 top-up once those claims are receipted. And a vault LP
 * that WON can only finish its 101 after every trader leg has detached. The app must:
 *   (1) order "Finish now" as 101 until final -> 46 (the viewer's own first, then any other open
 *       receipt) -> the rest -> the viewer's 76, all in one approval;
 *   (2) show one calm line while the viewer's receipt is partial, and once 101 has closed bundle
 *       the viewer's 46 into their next transaction (sim-gated);
 *   (3) each with a negative control.
 * The chain is an in-memory model driven through the REAL planner (planResolvedExit) from decoded
 * portfolio bytes, as in resolved-finish.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeResolvedMarket, decodeResolvedPortfolio } from "@/lib/limits/decode";
import { planResolvedExit, type ExitPortfolio, type ResolvedExitPlan } from "@/lib/limits/resolved-exit";
import { FINISH_MAX_TXS, buildFinishList, pruneRefusedItems, runFinish, stepNeeded, type FinishItem } from "@/lib/limits/resolved-finish";
import { sendWithTopup, viewerOwnedKeys, viewerReceiptStatus, viewerTopupSteps } from "@/lib/limits/resolved-topup";
import { COPY } from "@/lib/limits/copy";
import { afterLegsShift, blankMarket, blankPortfolio } from "../../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";


const VIEWER = Keypair.generate().publicKey;
const OTHER = Keypair.generate().publicKey;

// ── Model ──────────────────────────────────────────────────────────────────
interface P {
  key: string;
  vault: boolean;
  owner: PublicKey;
  /** 101 close-step chunks still to run (vault only). */
  chunks: number;
  /** Unpaid capital (a trader not closed yet, or the unpaid part of a partial receipt). */
  capital: bigint;
  receipt: "none" | "open" | "final";
  gone?: boolean;
}
function marketBytes(count: bigint, cTot: bigint): Uint8Array {
  const d = blankMarket();
  const v = new DataView(d.buffer);
  const M = marketOffsets(d);
  d[M.hdr(C.H_MODE)] = C.MARKET_MODE_RESOLVED;
  v.setBigUint64(M.hdr(C.H_C_TOT), cTot, true);
  v.setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), count, true);
  v.setBigUint64(M.hdr(C.H_RESOLVED_SLOT), 100n, true);
  return d;
}
function portfolio(p: P): ExitPortfolio {
  const d = new Uint8Array(blankPortfolio());
  const v = new DataView(d.buffer);
  d[10] = C.KIND_PORTFOLIO;
  d.set(p.owner.toBytes(), C.PF_OWNER);
  if (p.capital > 0n || p.chunks > 0) v.setBigUint64(C.PF_CAPITAL, p.capital > 0n ? p.capital : 1_000n, true);
  if (p.receipt !== "none") {
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_PRESENT] = 1;
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_FINALIZED] = p.receipt === "final" ? 1 : 0;
  }
  return { key: p.key, view: decodeResolvedPortfolio(d)!, isVaultLp: p.vault, escrowed: false };
}

class Chain {
  harvestable = 5n;
  requested = false;
  paid = new Map<string, bigint>();
  constructor(public ps: P[], public vaultWon = false) {}
  live() {
    return this.ps.filter((p) => !p.gone);
  }
  vault() {
    return this.ps.find((p) => p.vault)!;
  }
  /** 101 has closed: the vault LP's receipt is final (or its portfolio is gone). */
  vaultFinal() {
    const v = this.vault();
    return v.gone === true || (v.chunks === 0 && v.receipt === "final");
  }
  /** Every claim but `key`'s is receipted (the dilution rule: ANY unreceipted claimant dilutes). */
  othersReceipted(key: string) {
    return this.vaultFinal() && this.ps.filter((p) => !p.vault && p.key !== key && !p.gone).every((p) => p.receipt !== "none");
  }
  plan(): ResolvedExitPlan {
    const live = this.live();
    return planResolvedExit({
      market: decodeResolvedMarket(marketBytes(BigInt(live.length), live.reduce((a, p) => a + p.capital, 0n) + BigInt(live.filter((p) => p.chunks > 0).length) * 1_000n))!,
      nowSlot: 10_000n,
      portfolios: live.map(portfolio),
      boundVault: true,
      harvestableAtoms: this.harvestable,
    });
  }
  portfolios() {
    return this.live().map(portfolio);
  }
  clone(): Chain {
    const c = new Chain(this.ps.map((p) => ({ ...p })), this.vaultWon);
    c.harvestable = this.harvestable;
    return c;
  }
  private pay(key: string, a: bigint) {
    this.paid.set(key, (this.paid.get(key) ?? 0n) + a);
  }
  apply(it: FinishItem): void {
    const s = it.step;
    if (s.kind === "earn-request") {
      if (this.plan().phase !== "ready") throw new Error("not terminal-flat");
      this.requested = true;
      return;
    }
    if (s.kind === "harvest") {
      if (this.harvestable === 0n) throw new Error("NoFeesToCrank");
      this.harvestable = 0n;
      return;
    }
    const p = this.ps.find((x) => x.key === s.portfolio && !x.gone);
    if (!p) throw new Error("account gone");
    if (s.kind === "settle-vault-lp") {
      if (s.topup === 0) {
        if (p.chunks === 0) throw new Error("nothing to settle");
        // A vault LP that WON is progress-only until every trader leg has detached.
        if (this.vaultWon && this.ps.some((x) => !x.vault && !x.gone && x.receipt === "none")) return;
        p.chunks--;
        if (p.chunks === 0) p.receipt = "open";
      } else {
        if (p.receipt !== "open") throw new Error("no open receipt");
        p.receipt = "final";
      }
      return;
    }
    if (s.kind === "close-resolved") {
      if (p.receipt !== "none") throw new Error("already closed");
      if (this.othersReceipted(p.key)) {
        this.pay(p.key, p.capital);
        p.capital = 0n;
        p.receipt = "final";
      } else {
        // Diluted by the unreceipted claims: pays PART and opens a receipt.
        this.pay(p.key, p.capital / 2n);
        p.capital -= p.capital / 2n;
        p.receipt = "open";
      }
      return;
    }
    if (s.kind === "claim-topup") {
      if (p.receipt !== "open") throw new Error("no open receipt");
      if (!this.othersReceipted(p.key)) throw new Error("nothing more to pay yet");
      this.pay(p.key, p.capital);
      p.capital = 0n;
      p.receipt = "final";
      return;
    }
    if (p.capital > 0n || p.chunks > 0 || p.receipt === "open") throw new Error("not empty");
    p.gone = true;
  }
}

/** The hook's pre-sign pass (useResolvedExit.finish): simulate the FIRST needed item of each step
 *  against today's state, then pruneRefusedItems. `prune` is swappable for the negative control. */
function presign(chain: Chain, items: FinishItem[], prune: typeof pruneRefusedItems = pruneRefusedItems): FinishItem[] {
  const plan = chain.plan();
  const refused: FinishItem[] = [];
  const tried = new Set<string>();
  for (const it of items) {
    if (it.step.kind === "earn-request" || !stepNeeded(it, plan)) continue;
    const k = JSON.stringify(it.step);
    if (tried.has(k)) continue;
    tried.add(k);
    try {
      chain.clone().apply(it);
    } catch {
      refused.push(it);
    }
  }
  return prune(items, refused);
}

const label = (it: FinishItem) =>
  it.step.kind === "settle-vault-lp" ? `101(${it.step.topup})` : it.step.kind === "claim-topup" ? `46:${it.step.portfolio}` : it.step.kind === "close-resolved" ? `30:${it.step.portfolio}` : it.step.kind === "close-empty" ? `8:${it.step.portfolio}` : it.step.kind;

async function run(chain: Chain, items: FinishItem[]) {
  const sent: string[] = [];
  items = presign(chain, items);
  const r = await runFinish(
    items.map((item) => ({ item, tx: item })),
    {
      plan: async () => chain.plan(),
      broadcast: async (it) => {
        chain.apply(it);
        sent.push(label(it));
        return label(it);
      },
    },
  );
  return { r, sent };
}

const scenario = () =>
  new Chain([
    { key: "V", vault: true, owner: Keypair.generate().publicKey, chunks: 2, capital: 0n, receipt: "none" },
    // Other traders listed FIRST, so viewer-first is not an accident of input order.
    { key: "A", vault: false, owner: OTHER, chunks: 0, capital: 400n, receipt: "open" },
    { key: "B", vault: false, owner: OTHER, chunks: 0, capital: 800n, receipt: "none" },
    { key: "ME", vault: false, owner: VIEWER, chunks: 0, capital: 600n, receipt: "open" },
  ]);
const listFor = (c: Chain, withEarnRequest = true) =>
  buildFinishList({ portfolios: c.portfolios(), boundVault: true, withEarnRequest, viewerOwned: viewerOwnedKeys(c.portfolios(), VIEWER) });

// ── (1) Order ──────────────────────────────────────────────────────────────
describe("(1) Finish now: 101 until final, then 46 (viewer first), then the rest, then 76", () => {
  it("list order: 101s, then 46 viewer-first, then 30s, then 101 again, then 46 again, 8s, 78, 76", () => {
    const l = listFor(scenario()).map(label);
    const first46 = l.indexOf("46:ME");
    expect(l.slice(0, first46).every((x) => x.startsWith("101("))).toBe(true);
    expect(l.slice(first46, first46 + 2)).toEqual(["46:ME", "46:A"]);
    const c30 = l.indexOf("30:B");
    expect(c30).toBeGreaterThan(first46);
    const retry = l.indexOf("101(0)", c30);
    expect(retry).toBeGreaterThan(c30);
    const second46 = l.indexOf("46:ME", retry);
    expect(second46).toBeGreaterThan(retry);
    expect(l.indexOf("8:V")).toBeGreaterThan(second46);
    expect(l[l.length - 1]).toBe("earn-request");
  });

  it("the chain finishes: the viewer's partial receipt is topped up in full, 76 last, nothing refused", async () => {
    const c = scenario();
    const { r, sent } = await run(c, listFor(c));
    expect(r.failed).toBe(0);
    expect(sent.slice(0, 3)).toEqual(["101(0)", "101(0)", "101(1)"]);
    // B's claim was still unreceipted, so the first 46s had nothing more to pay (pruned at pre-sign);
    // after B closed, the second 46s pay — the viewer's first.
    expect(sent.indexOf("46:ME")).toBeGreaterThan(sent.indexOf("30:B"));
    expect(sent.indexOf("46:ME")).toBeLessThan(sent.indexOf("46:A"));
    expect(sent[sent.length - 1]).toBe("earn-request");
    expect(r.requested).toBe(true);
    expect(r.final.phase).toBe("ready");
    expect(c.paid.get("ME")).toBe(600n);
    expect(c.paid.get("A")).toBe(400n);
    expect(c.paid.get("B")).toBe(800n);
  });

  it("NEGATIVE CONTROL: pruning a refused 46 as a whole chain (the old rule) strands the viewer's receipt", async () => {
    const c = scenario();
    const chainDrop: typeof pruneRefusedItems = (items, refused) => {
      const k = (it: FinishItem) => ("portfolio" in it.step ? it.step.portfolio : it.step.kind);
      const d = new Set(refused.map(k));
      return items.filter((it) => !d.has(k(it)));
    };
    const items = presign(c, listFor(c), chainDrop);
    const r = await runFinish(items.map((item) => ({ item, tx: item })), { plan: async () => c.plan(), broadcast: async (it) => (c.apply(it), label(it)) });
    expect(c.paid.get("ME") ?? 0n).toBe(0n);
    expect(r.final.phase).not.toBe("ready");
  });

  it("NEGATIVE CONTROL: a 46 placed before the 101s never completes the viewer's receipt", async () => {
    const c = scenario();
    const items = listFor(c);
    const mine = items.filter((i) => label(i) === "46:ME");
    const reordered = [...mine, ...items.filter((i) => label(i) !== "46:ME")];
    const r = await runFinish(reordered.map((item) => ({ item, tx: item })), {
      plan: async () => c.plan(),
      broadcast: async (it) => (c.apply(it), label(it)),
    });
    expect(c.paid.get("ME") ?? 0n).toBe(0n);
    expect(r.final.phase).not.toBe("ready");
  });

  it("a vault LP that WON finishes only after the traders detach: the 101 retry block does it", async () => {
    const mk = () =>
      new Chain(
        [
          { key: "V", vault: true, owner: Keypair.generate().publicKey, chunks: 1, capital: 0n, receipt: "none" },
          { key: "T", vault: false, owner: OTHER, chunks: 0, capital: 300n, receipt: "none" },
          { key: "ME", vault: false, owner: VIEWER, chunks: 0, capital: 500n, receipt: "none" },
        ],
        true,
      );
    const c = mk();
    const { r, sent } = await run(c, listFor(c));
    expect(r.failed).toBe(0);
    expect(r.final.phase).toBe("ready");
    expect(r.requested).toBe(true);
    expect(sent.lastIndexOf("101(0)")).toBeGreaterThan(sent.indexOf("30:ME"));
    expect(c.paid.get("ME")).toBe(500n);
    expect(c.paid.get("T")).toBe(300n);
    // NEGATIVE CONTROL: without the retry block (101 only up front) the market never finishes.
    const n = mk();
    const noRetry = listFor(n).filter((i) => !(i.step.kind === "settle-vault-lp" && i.copy >= 10));
    const { r: r2 } = await run(n, noRetry);
    expect(r2.final.phase).not.toBe("ready");
    expect(r2.requested).toBe(false);
  });

  it("viewer-first survives the FINISH_MAX_TXS cap; NEGATIVE CONTROL without it the viewer's 46 is cut", () => {
    const ps: P[] = [{ key: "V", vault: true, owner: Keypair.generate().publicKey, chunks: 2, capital: 0n, receipt: "none" }];
    for (let i = 0; i < 30; i++) ps.push({ key: `O${i}`, vault: false, owner: OTHER, chunks: 0, capital: 10n, receipt: "open" });
    ps.push({ key: "ME", vault: false, owner: VIEWER, chunks: 0, capital: 600n, receipt: "open" });
    const c = new Chain(ps);
    expect(listFor(c, false).slice(0, FINISH_MAX_TXS).map(label)).toContain("46:ME");
    const without = buildFinishList({ portfolios: c.portfolios(), boundVault: true, withEarnRequest: false }).slice(0, FINISH_MAX_TXS);
    expect(without.map(label)).not.toContain("46:ME");
  });

  it("pruneRefusedItems: a refused 46 drops only itself; a refused 30 drops its portfolio's chain", () => {
    const items = listFor(scenario());
    const first46 = items.find((i) => label(i) === "46:ME" && i.copy === 0)!;
    const kept = pruneRefusedItems(items, [first46]).map((i) => `${label(i)}#${i.copy}`);
    expect(kept).not.toContain("46:ME#0");
    expect(kept).toContain("46:ME#1");
    const b30 = items.find((i) => label(i) === "30:B")!;
    expect(pruneRefusedItems(items, [b30]).some((i) => "portfolio" in i.step && i.step.portfolio === "B")).toBe(false);
  });
});

// ── (2) The calm line + the bundled top-up ─────────────────────────────────
describe("(2) partial receipt: one calm line until final; the top-up rides along", () => {
  it("copy is the one calm line", () => {
    expect(COPY.resolvedExit.partialReceipt).toBe("Part of your payout is on its way — it completes automatically once the market finishes settling.");
  });

  it("status stays partial until the receipt is FINAL; a 46 is offered whenever it is open; NEGATIVE CONTROLS", () => {
    const c = scenario();
    // Open receipt, vault LP still settling: still partial, and its 46 is planned (dilution by ANY claim).
    expect(viewerReceiptStatus(c.plan(), c.portfolios(), VIEWER)).toBe("partial-ready");
    expect(viewerTopupSteps(c.plan(), c.portfolios(), VIEWER)).toEqual([{ kind: "claim-topup", portfolio: "ME" }]);
    // The owners' window: partial, but nothing the app can run yet.
    const win = planResolvedExit({
      market: { ...decodeResolvedMarket(marketBytes(4n, 1_000n))!, forceCloseDelaySlots: 1_000_000n },
      nowSlot: 10_000n,
      portfolios: c.portfolios(),
      boundVault: true,
      harvestableAtoms: 0n,
    });
    expect(viewerReceiptStatus(win, c.portfolios(), VIEWER)).toBe("partial-waiting");
    // A stranger / no wallet sees nothing; A's open receipt is not the viewer's.
    expect(viewerReceiptStatus(c.plan(), c.portfolios(), Keypair.generate().publicKey)).toBe("none");
    expect(viewerReceiptStatus(c.plan(), c.portfolios(), null)).toBe("none");
    const me = c.ps.find((p) => p.key === "ME")!;
    me.receipt = "final";
    me.capital = 0n;
    expect(viewerReceiptStatus(c.plan(), c.portfolios(), VIEWER)).toBe("none");
  });

  const ix = (n: number) => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.from([n]) });
  class Refusal extends Error {}

  it("bundles the top-up in front of the user's own tx", async () => {
    const send = vi.fn(async (ixs: TransactionInstruction[], bundled: boolean) => ({ n: ixs.length, bundled }));
    const r = await sendWithTopup({ topup: [ix(46)], base: [ix(77)], send, isPreSignRefusal: (e) => e instanceof Refusal });
    expect(r).toEqual({ n: 2, bundled: true });
    expect(send.mock.calls[0]![0].map((i) => i.data[0])).toEqual([46, 77]);
  });

  it("a refused bundle falls back to the user's tx alone; NEGATIVE CONTROL other errors are not swallowed", async () => {
    const send = vi.fn(async (ixs: TransactionInstruction[], bundled: boolean) => {
      if (bundled) throw new Refusal("46 refused");
      return ixs.map((i) => i.data[0]);
    });
    expect(await sendWithTopup({ topup: [ix(46)], base: [ix(77)], send, isPreSignRefusal: (e) => e instanceof Refusal })).toEqual([77]);
    const boom = vi.fn(async () => {
      throw new Error("user rejected");
    });
    await expect(sendWithTopup({ topup: [ix(46)], base: [ix(77)], send: boom, isPreSignRefusal: (e) => e instanceof Refusal })).rejects.toThrow("user rejected");
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("no top-up: the user's tx is sent unchanged", async () => {
    const send = vi.fn(async (ixs: TransactionInstruction[], bundled: boolean) => ({ n: ixs.length, bundled }));
    expect(await sendWithTopup({ topup: [], base: [ix(76)], send, isPreSignRefusal: () => true })).toEqual({ n: 1, bundled: false });
  });

  it("wiring: the Earn payout path bundles the viewer's top-up; Finish now orders viewer-first", () => {
    const src = (f: string) => readFileSync(join(__dirname, "..", "..", "..", f), "utf8");
    const lp = src("hooks/useInsuranceLP.ts");
    expect(lp).toMatch(/readViewerTopupIxs\(/);
    expect(lp).toMatch(/sendWithTopup\(/);
    const rx = src("hooks/useResolvedExit.ts");
    expect(rx.match(/viewerOwned: viewerOwnedKeys\(/g)?.length).toBe(2); // finish + estimate
    expect(rx).toMatch(/viewerReceiptStatus\(/);
    expect(src("components/limits/ResolvedExitPanel.tsx")).toMatch(/COPY\.resolvedExit\.partialReceipt/);
  });
});
