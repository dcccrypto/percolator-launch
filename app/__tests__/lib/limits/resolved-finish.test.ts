// @vitest-environment node
/**
 * UX WP-8 (audit §3.9, RX-1): a settled market's Earn exit.
 *  AC1  the payout time is a date / time with a relative phrase, NEVER a slot number;
 *  AC2  "Finish now" is ONE approval: every step pre-signed (repeatable steps as copies with
 *       distinct compute-unit prices, so distinct signatures), the user's own request last;
 *  AC3  keeper-first: the plan flips to "ready" with no user action (the poll re-reads);
 *  AC4  copies that turn out unneeded are NEVER broadcast (broadcasts == steps the market needed).
 * The chain is an in-memory model driven through the REAL planner (planResolvedExit) from decoded
 * portfolio bytes; the real BPF run of the same chain is scripts/limits-parity/p3-sim
 * (limits_app_p3_finish_now_one_approval).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeResolvedMarket, decodeResolvedPortfolio } from "@/lib/limits/decode";
import { planResolvedExit, type ExitPortfolio, type ResolvedExitPlan } from "@/lib/limits/resolved-exit";
import {
  FINISH_COPIES,
  buildFinishList,
  buildFinishTxs,
  finishEstimate,
  finishItemCu,
  planPortfolios,
  runFinish,
  stepNeeded,
  type FinishItem,
} from "@/lib/limits/resolved-finish";
import { KEEPER_SWEEP_MARGIN_MS, SLOT_MS, finishFeeSol, relativePhrase, resolvedPayoutEta } from "@/lib/limits/resolved-eta";
import type { ExitIxContext } from "@/lib/limits/resolved-exit-ixs";
import { afterLegsShift, blankMarket, blankPortfolio } from "../../helpers/v22-fixtures";
import { marketOffsets } from "@/lib/v22/market-offsets";


// ── A tiny resolved market, planned by the real planner ─────────────────────
interface PState {
  key: string;
  vault: boolean;
  /** Chunked steps still needed (101 for the vault, 30 for a trader) before the payout receipt opens. */
  chunks: number;
  receipt: "none" | "open" | "final";
  escrowed?: boolean;
  gone?: boolean;
}
function marketBytes(count: bigint, cTot: bigint, resolvedSlot: bigint, delay: bigint): Uint8Array {
  const d = blankMarket();
  const v = new DataView(d.buffer);
  const M = marketOffsets(d);
  d[M.hdr(C.H_MODE)] = C.MARKET_MODE_RESOLVED;
  v.setBigUint64(M.hdr(C.H_C_TOT), cTot, true);
  v.setBigUint64(M.hdr(C.H_MATERIALIZED_PORTFOLIO_COUNT), count, true);
  v.setBigUint64(M.hdr(C.H_RESOLVED_SLOT), resolvedSlot, true);
  v.setBigUint64(C.HEADER_LEN + C.WCFG_FORCE_CLOSE_DELAY_SLOTS, delay, true);
  return d;
}
function portfolio(p: PState): ExitPortfolio {
  const d = new Uint8Array(blankPortfolio());
  const v = new DataView(d.buffer);
  d[10] = C.KIND_PORTFOLIO;
  if (p.chunks > 0) v.setBigUint64(C.PF_CAPITAL, 1_000n, true);
  if (p.receipt !== "none") {
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_PRESENT] = 1;
    d[C.PF_RESOLVED_PAYOUT_RECEIPT + afterLegsShift() + C.RECEIPT_FINALIZED] = p.receipt === "final" ? 1 : 0;
  }
  const view = decodeResolvedPortfolio(d)!;
  return { key: p.key, view, isVaultLp: p.vault, escrowed: !!p.escrowed };
}

class Chain {
  harvestable = 5n;
  requested = false;
  broadcasts: string[] = [];
  constructor(public ps: PState[], public nowSlot = 10_000n, public resolvedSlot = 100n, public delay = 0n) {}
  live() {
    return this.ps.filter((p) => !p.gone);
  }
  plan(): ResolvedExitPlan {
    const live = this.live();
    return planResolvedExit({
      market: decodeResolvedMarket(marketBytes(BigInt(live.length), BigInt(live.filter((p) => p.chunks > 0).length) * 1_000n, this.resolvedSlot, this.delay))!,
      nowSlot: this.nowSlot,
      portfolios: live.map(portfolio),
      boundVault: true,
      harvestableAtoms: this.harvestable,
    });
  }
  portfolios() {
    return this.live().map(portfolio);
  }
  /** Apply an item; the program would REFUSE an unneeded one, so this throws (AC4 would catch it). */
  apply(it: FinishItem): void {
    const s = it.step;
    if (s.kind === "earn-request") {
      if (this.plan().phase !== "ready") throw new Error("77 would not pay yet");
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
    if (s.kind === "close-empty") {
      if (p.chunks > 0 || p.receipt === "open") throw new Error("not empty");
      p.gone = true;
    } else if ((s.kind === "settle-vault-lp" && s.topup === 0) || s.kind === "close-resolved") {
      if (p.chunks === 0) throw new Error("nothing to settle");
      p.chunks--;
      if (p.chunks === 0) p.receipt = "open";
    } else {
      if (p.receipt !== "open") throw new Error("no open receipt");
      p.receipt = "final";
    }
  }
}

const tag = (it: FinishItem) => `${it.step.kind}${"portfolio" in it.step ? ":" + it.step.portfolio : ""}#${it.copy}`;

async function finishOn(chain: Chain, withEarnRequest: boolean, failWith?: (i: number) => string | null) {
  const items = buildFinishList({ portfolios: chain.portfolios(), boundVault: true, withEarnRequest });
  let n = 0;
  const run = await runFinish(
    items.map((item) => ({ item, tx: item })),
    {
      plan: async () => chain.plan(),
      broadcast: async (it) => {
        const f = failWith?.(n++) ?? null;
        if (f) throw new Error(f);
        chain.apply(it);
        chain.broadcasts.push(tag(it));
        return `sig-${chain.broadcasts.length}`;
      },
    },
  );
  return { items, run };
}

describe("AC2 + AC4: one pre-signed list, only needed copies broadcast", () => {
  it("vault (2 chunks) + traders (1 and 3 chunks) + harvest + the user's request: broadcasts == needed steps; final ready", async () => {
    const chain = new Chain([
      { key: "V", vault: true, chunks: 2, receipt: "none" },
      { key: "A", vault: false, chunks: 1, receipt: "none" },
      { key: "B", vault: false, chunks: 3, receipt: "none" },
    ]);
    const { items, run } = await finishOn(chain, true);
    // pre-signed (blocks A-G, lib/limits/resolved-finish.ts): vault 101 x3 + 101(1) x2; traders 30 x3
    // each; the 101 retry 2 + 2; per trader a 30 retry + a 46; three close-empties; harvest; request
    expect(items).toHaveLength(5 + 3 + 3 + 4 + 4 + 3 + 1 + 1);
    // needed: V 2+1+1, A 1+1+1, B 3+1+1, harvest 1, request 1
    expect(run.broadcast).toBe(14);
    expect(run.skipped).toBe(items.length - 14);
    expect(run.failed).toBe(0);
    expect(run.final.phase).toBe("ready");
    expect(run.requested).toBe(true);
    expect(chain.requested).toBe(true);
    // the vault settles before any trader moves (a winner's close is progress-only until then)
    expect(chain.broadcasts.findIndex((t) => t.startsWith("close-resolved"))).toBeGreaterThan(chain.broadcasts.lastIndexOf("settle-vault-lp:V#1"));
    // no copy broadcast twice for a step that was already done
    expect(chain.broadcasts.filter((t) => t.startsWith("close-resolved:A"))).toEqual(["close-resolved:A#0"]);
  });

  it("NEGATIVE CONTROL: broadcasting every pre-signed copy (no re-plan) hits refused steps", async () => {
    const chain = new Chain([{ key: "A", vault: false, chunks: 1, receipt: "none" }]);
    chain.harvestable = 0n;
    const items = buildFinishList({ portfolios: chain.portfolios(), boundVault: false, withEarnRequest: false });
    const refused: string[] = [];
    for (const it of items) {
      try {
        chain.apply(it);
      } catch (e) {
        refused.push((e as Error).message);
      }
    }
    // block C's copies + block E's retry copy, less the one the market needed
    expect(refused.length).toBe(FINISH_COPIES["close-resolved"] + 1 - 1);
  });

  it("more chunks than copies: it stops without a failure and the keeper finishes the rest", async () => {
    const chain = new Chain([{ key: "B", vault: false, chunks: 5, receipt: "none" }]);
    const { run } = await finishOn(chain, true);
    expect(run.failed).toBe(0);
    expect(run.broadcast).toBe(FINISH_COPIES["close-resolved"] + 1); // + block E's retry copy
    expect(run.final.phase).toBe("sweep");
    expect(run.requested).toBe(false);
  });

  it("an NFT-held position: its chain is not in the list, the request is not broadcast (market never flat)", async () => {
    const chain = new Chain([
      { key: "A", vault: false, chunks: 1, receipt: "none" },
      { key: "N", vault: false, chunks: 1, receipt: "none", escrowed: true },
    ]);
    const { items, run } = await finishOn(chain, true);
    expect(items.some((i) => "portfolio" in i.step && i.step.portfolio === "N")).toBe(false);
    expect(run.requested).toBe(false);
    expect(run.final.phase).not.toBe("ready");
    expect(run.final.phase !== "not-resolved" && run.final.blockers).toEqual([{ kind: "escrowed", portfolio: "N" }]);
  });

  it("an expired blockhash stops the run (stale) instead of failing every remaining tx", async () => {
    const chain = new Chain([{ key: "A", vault: false, chunks: 1, receipt: "none" }]);
    const { run } = await finishOn(chain, false, (i) => (i === 1 ? "Blockhash not found" : null));
    expect(run.stale).toBe(true);
    expect(run.broadcast).toBe(1);
    expect(run.failed).toBe(1);
  });

  it("owners' window: only the portfolios the plan can touch now (empties), nothing else pre-signed", () => {
    const chain = new Chain(
      [
        { key: "E", vault: false, chunks: 0, receipt: "none" },
        { key: "A", vault: false, chunks: 1, receipt: "none" },
      ],
      150n,
      100n,
      1_000n,
    );
    const plan = chain.plan();
    expect(plan.phase).toBe("owner-window");
    const items = buildFinishList({ portfolios: chain.portfolios(), boundVault: true, withEarnRequest: false, only: planPortfolios(plan) });
    expect(items.filter((i) => i.step.kind !== "harvest").map(tag)).toEqual(["close-empty:E#0"]);
  });

  it("stepNeeded: the request only once ready; a done step is not needed", () => {
    const req: FinishItem = { step: { kind: "earn-request" }, copy: 0 };
    expect(stepNeeded(req, { phase: "ready", blockers: [] })).toBe(true);
    expect(stepNeeded(req, { phase: "sweep", steps: [], blockers: [] })).toBe(false);
    expect(stepNeeded({ step: { kind: "close-resolved", portfolio: "A" }, copy: 1 }, { phase: "sweep", steps: [{ kind: "close-empty", portfolio: "A", isVaultLp: false }], blockers: [] })).toBe(false);
  });
});

describe("AC2: the pre-signed list is signable in one approval", () => {
  const k = () => Keypair.generate().publicKey;
  const ctx = (): ExitIxContext => {
    const market = k();
    return {
      payer: k(), collateralMint: k(), vaultToken: k(), vaultAuthority: k(), programId: k(), market,
      portfolios: new Map([["A", { owner: k(), portfolioId: 1n, matcherSequence: 0n, positionEpoch: 0n }]]),
      vault: null,
    };
  };
  it("every tx is distinct (copies differ by compute-unit price) and sized to its step", () => {
    const c = ctx();
    const a = new PublicKey(Keypair.generate().publicKey).toBase58();
    c.portfolios = new Map([[a, { owner: k(), portfolioId: 1n, matcherSequence: 0n, positionEpoch: 0n }]]);
    const items: FinishItem[] = [0, 1, 2].map((copy) => ({ step: { kind: "close-resolved", portfolio: a }, copy }));
    items.push({ step: { kind: "close-empty", portfolio: a, isVaultLp: false }, copy: 0 });
    const txs = buildFinishTxs(items, c, null, { blockhash: "11111111111111111111111111111111", priorityFeeMicroLamports: 1000, feePayer: c.payer });
    const msgs = txs.map((t) => t.serializeMessage().toString("base64"));
    expect(new Set(msgs).size).toBe(items.length);
    for (const t of txs) expect(t.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1232);
    expect(items.map(finishItemCu)).toEqual([400_000, 400_000, 400_000, 200_000]);
  });
  it("the request item needs the caller's 76", () => {
    const c = ctx();
    expect(() => buildFinishTxs([{ step: { kind: "earn-request" }, copy: 0 }], c, null, { blockhash: "11111111111111111111111111111111", priorityFeeMicroLamports: 0, feePayer: c.payer })).toThrow(/request instruction/);
  });
  it("the estimate counts steps, not copies", () => {
    const items = buildFinishList({
      portfolios: new Chain([{ key: "A", vault: false, chunks: 1, receipt: "none" }]).portfolios(),
      boundVault: true,
      withEarnRequest: true,
    });
    const e = finishEstimate(items);
    expect(e.steps).toBe(4); // close, claim, close-empty, harvest
    expect(e.sol).toBe(finishFeeSol({ txs: items.length - 1, payoutAccounts: 1 }));
  });
});

describe("AC1: a time, never a slot", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  it("the owners' window left + the sweep margin, formatted in the viewer's zone", () => {
    const e = resolvedPayoutEta({ untilSlot: 1_000_000n + 216_000n, nowSlot: 1_000_000n, now, locale: "en-GB", timeZone: "UTC" });
    expect(e.at.getTime()).toBe(now.getTime() + 216_000 * SLOT_MS + KEEPER_SWEEP_MARGIN_MS);
    expect(e.label).toMatch(/Thu 1 Oct/);
    expect(e.relative).toBe("in about 24 hours");
    expect(e.label).toContain("12:10");
    for (const n of ["216000", "1216000", "1000000", "216,000"]) expect(e.label + e.relative).not.toContain(n);
  });
  it("past the window: just the sweep margin", () => {
    const e = resolvedPayoutEta({ untilSlot: 5n, nowSlot: 900n, now, locale: "en-GB", timeZone: "UTC" });
    expect(e.relative).toBe("in about 10 minutes");
    expect(resolvedPayoutEta({ untilSlot: null, nowSlot: 1n, now }).relative).toBe("in about 10 minutes");
  });
  it("relative phrases", () => {
    expect(relativePhrase(30_000)).toBe("in about 1 minute");
    expect(relativePhrase(3 * 3_600_000)).toBe("in about 3 hours");
    expect(relativePhrase(5 * 86_400_000)).toBe("in about 5 days");
  });
});

describe("the viewer's Earn position in the panel", () => {
  it("amount + requestable shares; none while a request is pending; nothing without shares", async () => {
    const { earnExitProps } = await import("@/lib/limits/resolved-finish");
    expect(earnExitProps({ userLpBalance: 10n, userRedeemableValue: 1_250_000_000n, pendingRedemptionShares: 0n }, 6, "USDC")).toEqual({ earnAmount: "1250 USDC", requestableShares: 10n, requestQuoteAtoms: null }); // no NAV given: no quote (AUD-S1-18)
    expect(earnExitProps({ userLpBalance: 10n, userRedeemableValue: 1n, pendingRedemptionShares: 4n }, 6, "USDC").requestableShares).toBe(0n);
    expect(earnExitProps({ userLpBalance: 0n, userRedeemableValue: 0n, pendingRedemptionShares: 0n }, 6, "USDC")).toEqual({ earnAmount: null, requestableShares: 0n, requestQuoteAtoms: null });
  });
});
