// @vitest-environment node
/**
 * checkOpenMarketGuards on the recorded devnet SOL market + LP portfolio + matcher context (no mocks):
 * clerk F2 (stale oracle refuses opens, never reducing orders) and clerk F3 (per-side size cap).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { checkOpenMarketGuards } from "@/lib/bot-api/builders/caps";
import { decodeMarket } from "@/lib/bot-api/reads/market";
import { buildQuoteSource } from "@/lib/bot-api/reads/quote";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import type { TradePreflight } from "@/lib/v22/trade-build";
import { SOL, SOL_DATA, LP, LP_DATA, CTX, CTX_DATA, WRAPPER, SOL_SLOT } from "./fake-chain";

const raw = (b: Buffer) => new Uint8Array(b);
const at = (slot: number) => ({ market: SOL, programId: WRAPPER, slot });
beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

/** A slot at which the market's oracle is `ageSecs` old under its own staleness bound. */
function slotAtAge(ageSecs: number): number {
  const v = decodeMarket(raw(SOL_DATA), at(SOL_SLOT));
  return Number(v.oracle.lastPushSlot) + Math.round((ageSecs * 1000) / 400);
}
const conn = (slot: number, calls: { n: number } = { n: 0 }) =>
  ({
    getMultipleAccountsInfoAndContext: async () => {
      calls.n++;
      return {
        context: { slot },
        value: [SOL_DATA, CTX_DATA, LP_DATA].map((data) => ({ data, owner: WRAPPER, lamports: 1, executable: false })),
      };
    },
  }) as unknown as Connection;
const pre = (o: Partial<TradePreflight> = {}): TradePreflight => {
  const size = o.size ?? 1_000n;
  return {
  size: 1_000n,
  // far on the loose side for both directions, so the slippage pre-check (tested in slippage-precheck.test.ts) stays out of these cases
  limitPriceE6: size > 0n ? 10n ** 12n : 1n,
  effectivePriceE6: 1n,
  positionBeforeQ: 0n,
  positionLegReset: false,
  reducing: false,
  marketData: raw(SOL_DATA),
  portfolioData: null,
  programId: WRAPPER,
  market: SOL,
  lp: { accountB: LP, matcherCtx: CTX },
  ...o,
  };
};
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "throw");

describe("stale oracle", () => {
  it("refuses a buy and a sell on a stale market (the flag /v1/markets exposes), with the age in the details", async () => {
    const bound = decodeMarket(raw(SOL_DATA), at(SOL_SLOT)).oracle.staleBoundSecs;
    const stale = slotAtAge(bound + 60);
    expect(decodeMarket(raw(SOL_DATA), at(stale)).oracle.stale).toBe(true);
    expect(await code(checkOpenMarketGuards(conn(stale), pre()))).toBe("market_stale");
    expect(await code(checkOpenMarketGuards(conn(stale), pre({ size: -1_000n })))).toBe("market_stale");
    const e = await checkOpenMarketGuards(conn(stale), pre()).catch((x) => x);
    expect(e.extra.details).toMatchObject({ staleBoundSecs: bound });
  });
  it("accepts a fresh market", async () => {
    const bound = decodeMarket(raw(SOL_DATA), at(SOL_SLOT)).oracle.staleBoundSecs;
    const fresh = slotAtAge(bound - 30);
    expect(decodeMarket(raw(SOL_DATA), at(fresh)).oracle.stale).toBe(false);
    expect(await code(checkOpenMarketGuards(conn(fresh), pre()))).toBe("ok");
  });
  it("never blocks a reducing order: stale oracle, size above the cap, even a failed read pass", async () => {
    const stale = slotAtAge(decodeMarket(raw(SOL_DATA), at(SOL_SLOT)).oracle.staleBoundSecs + 600);
    const reduce = { reducing: true, positionBeforeQ: 5_000n, size: -1_000n };
    expect(await code(checkOpenMarketGuards(conn(stale), pre(reduce)))).toBe("ok");
    expect(await code(checkOpenMarketGuards(conn(stale), pre({ ...reduce, size: -(2n ** 90n) })))).toBe("ok");
    const bad = { getMultipleAccountsInfoAndContext: async () => { throw new Error("429"); } } as unknown as Connection;
    expect(await checkOpenMarketGuards(bad, pre(reduce))).toEqual({ expectedFeeBps: null, expectedFeeAtoms: null, allInCostBps: null, allInCostAtoms: null });
  });
  it("reports the expected fee: base fee plus the matcher's adaptive request, in bps and atoms", async () => {
    const fresh = slotAtAge(decodeMarket(raw(SOL_DATA), at(SOL_SLOT)).oracle.staleBoundSecs - 30);
    const r = await checkOpenMarketGuards(conn(fresh), pre({ size: 1_000_000n }));
    expect(r.expectedFeeBps).toBeGreaterThanOrEqual(Number(decodeMarket(raw(SOL_DATA), at(fresh)).feeBps));
    expect(r.expectedFeeAtoms).not.toBeNull();
  });
  it("an RPC failure is rpc_unavailable, not a pass", async () => {
    const bad = { getMultipleAccountsInfoAndContext: async () => { throw new Error("429 https://secret.example"); } } as unknown as Connection;
    expect(await code(checkOpenMarketGuards(bad, pre()))).toBe("rpc_unavailable");
  });
});

describe("per-side size cap", () => {
  const fresh = () => slotAtAge(decodeMarket(raw(SOL_DATA), at(SOL_SLOT)).oracle.staleBoundSecs - 30);
  const max = () => buildQuoteSource(raw(SOL_DATA), raw(CTX_DATA), raw(LP_DATA), LP, at(fresh())).maxSizePerSide;
  it("refuses an order above the quote's maxSizePerSide for its side, accepts the maximum", async () => {
    const m = max();
    const sides = [["long", 1n], ["short", -1n]] as const;
    let checked = 0;
    for (const [side, sign] of sides) {
      const q = m[side].maxQ;
      if (q >= 2n ** 100n) continue; // unlimited side
      checked++;
      expect(await code(checkOpenMarketGuards(conn(fresh()), pre({ size: sign * q })))).toBe("ok");
      const e = await checkOpenMarketGuards(conn(fresh()), pre({ size: sign * (q + 1n) })).catch((x) => x);
      expect(e.code).toBe("size_cap_exceeded");
      expect(e.extra.details).toMatchObject({ maxQ: q.toString(), side });
    }
    expect(checked).toBeGreaterThan(0);
  });
});
