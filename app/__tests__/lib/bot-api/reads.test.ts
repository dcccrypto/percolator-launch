// @vitest-environment node
/** Bot API read libs on recorded devnet bytes: market decode and freshness, funding, quote/depth math, account view, history merge, SSE. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";

vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  getMarketDiscoveryProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
  getAllProgramIds: () => ["5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe"],
}));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ApiError } from "@/lib/bot-api/errors";
import { DEFAULT_STALE_SECS, decodeMarket, decodeMarketDetail } from "@/lib/bot-api/reads/market";
import { buildQuoteSource, depthView, quoteView, DEPTH_LADDER_USD } from "@/lib/bot-api/reads/quote";
import { portfolioView, liqPriceWithMmFloor } from "@/lib/bot-api/reads/account";
import { mergeSignatures, parseBefore, parseLimit } from "@/lib/bot-api/reads/history";
import { parsePubkey } from "@/lib/bot-api/reads/common";
import { marketEventStream, parseLastEventId } from "@/lib/bot-api/stream";
import { decodeFundingV22 } from "@/lib/v22/funding";
import { marketGeometry, parsePortfolio } from "@/lib/v22/layout";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { GATO, GATO_DATA, WRAPPER, SOL, SOL_DATA, LP, LP_DATA, CTX_DATA, SOL_ORACLE, GOLDEN, MULTI_DATA, MULTI, V21, V21_DATA } from "./fake-chain";

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const raw = (b: Buffer) => new Uint8Array(b);
const GATO_LAST_PUSH = 522053532;

describe("market decode", () => {
  it("decodes the recorded GATO market", () => {
    const v = decodeMarket(raw(GATO_DATA), { market: GATO, programId: WRAPPER, slot: GATO_LAST_PUSH + 3 });
    expect(v).toMatchObject({ market: GATO.toBase58(), programId: WRAPPER.toBase58(), lotExp: expect.any(Number), assets: 1, oracleMode: "keeper", feeBps: 30n, maxLeverage: 10 });
    expect(v.effectivePriceE6).toBe(7665000n);
    expect(v.targetPriceE6).toBe(7665000n);
    expect(v.markEwmaE6).toBe(7666000n);
    expect(v.openInterest).toEqual({ longQ: 0n, shortQ: 0n });
    expect(v.oracle).toMatchObject({ lastPushSlot: BigInt(GATO_LAST_PUSH), ageSlots: 3, ageSecs: 1.2, staleBoundSource: "default", staleBoundSecs: DEFAULT_STALE_SECS, stale: false });
  });
  it("is stale once the oracle push is older than the bound (default bound: market has none)", () => {
    const atBound = Math.round((DEFAULT_STALE_SECS * 1000) / 400);
    expect(decodeMarket(raw(GATO_DATA), { market: GATO, programId: WRAPPER, slot: GATO_LAST_PUSH + atBound }).oracle.stale).toBe(false);
    expect(decodeMarket(raw(GATO_DATA), { market: GATO, programId: WRAPPER, slot: GATO_LAST_PUSH + atBound + 5 }).oracle.stale).toBe(true);
  });
  it("uses the market's own staleness bound when it has one", () => {
    const d = Buffer.from(GATO_DATA);
    const g = marketGeometry(raw(d));
    // AssetOracleProfile.max_staleness_secs: find it by the SDK parse (it is the u64 the parser reads); patch through a known offset
    // by trial: the profile field order puts it after the authorities. Verify by decode, not by assumption.
    const probe = (off: number) => {
      const c = Buffer.from(d);
      c.writeBigUInt64LE(30n, g.slotOff(0) + off);
      return decodeMarket(raw(c), { market: GATO, programId: WRAPPER, slot: GATO_LAST_PUSH + 100 }).oracle;
    };
    let found: ReturnType<typeof probe> | null = null;
    for (let off = 0; off < 512 && !found; off += 8) {
      try {
        const o = probe(off);
        if (o.staleBoundSource === "market") found = o;
      } catch {
        /* a patch that breaks the decode is not the field */
      }
    }
    expect(found).not.toBeNull();
    expect(found!.staleBoundSecs).toBe(30);
    expect(found!.stale).toBe(true); // 100 slots = 40 s > 30 s
  });
  it("detail adds the risk parameters", () => {
    const v = decodeMarketDetail(raw(GATO_DATA), { market: GATO, programId: WRAPPER, slot: GATO_LAST_PUSH });
    expect(v.risk).toMatchObject({ initialMarginBps: 1000n, maintenanceMarginBps: 500n, maxTradingFeeBps: 700n, maxRequestedFeeBps: 100, maxAbsFundingE9PerSlot: 111n, liquidationFeeBps: 50n });
  });
  it("market_unsupported for a v2.1 market and a multi-asset market; market_unreadable for truncated bytes", () => {
    const at = { programId: WRAPPER, slot: 1 };
    expect(() => decodeMarket(raw(V21_DATA), { ...at, market: V21 })).toThrowError(expect.objectContaining({ code: "market_unsupported" }));
    expect(() => decodeMarket(raw(MULTI_DATA), { ...at, market: MULTI })).toThrowError(expect.objectContaining({ code: "market_unsupported" }));
    let err: unknown;
    try {
      decodeMarket(raw(GATO_DATA.subarray(0, 700)), { ...at, market: GATO });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(["market_unreadable", "market_unsupported"]).toContain((err as ApiError).code);
  });
});

describe("funding on a funding-on market", () => {
  /** GATO has funding managed but no open interest, so its applied rate is 0; give it both sides and a mark away from the index. */
  function withExposure(markE6: bigint): Uint8Array {
    const d = Buffer.from(GATO_DATA);
    const g = marketGeometry(raw(d));
    const e = g.engineOff(0);
    d.writeBigUInt64LE(5_000_000n, e + 289); // oi_eff_long_q (u128 low)
    d.writeBigUInt64LE(0n, e + 289 + 8);
    d.writeBigUInt64LE(5_000_000n, e + 305);
    d.writeBigUInt64LE(0n, e + 305 + 8);
    d.writeBigUInt64LE(markE6, g.slotOff(0) + 432); // funding_mark_e6
    return raw(d);
  }
  it("flat recorded market: enabled, rate 0, nobody pays", () => {
    const f = decodeFundingV22(raw(GATO_DATA), 0)!;
    expect(f).toMatchObject({ managed: true, bothSides: false, rateE9PerSlot: 0n, direction: "none", pctPer8h: 0 });
    expect(f.maxAbsE9).toBe(111n);
  });
  it("mark above the index: longs pay shorts, bounded by the market's max", () => {
    const f = decodeFundingV22(withExposure(7_900_000n), 0)!;
    expect(f.bothSides).toBe(true);
    expect(f.premiumE9).toBe(111n);
    expect(f.rateE9PerSlot).toBe(111n);
    expect(f.direction).toBe("longs-pay-shorts");
    expect(f.pctPer8h).toBeCloseTo((111 * 72_000) / 1e9 * 100, 9);
  });
  it("mark below the index: shorts pay longs", () => {
    const f = decodeFundingV22(withExposure(7_000_000n), 0)!;
    expect(f.rateE9PerSlot).toBe(-111n);
    expect(f.direction).toBe("shorts-pay-longs");
  });
});

describe("quote and depth on the recorded SOL market + LP + matcher", () => {
  const SLOT = Number(SOL_ORACLE.slot);
  const src = () => buildQuoteSource(raw(SOL_DATA), raw(CTX_DATA), raw(LP_DATA), LP, { market: SOL, programId: WRAPPER, slot: SLOT });
  it("prices exactly what the deployed matcher charges (golden, both sides, non-reducing)", () => {
    const s = src();
    expect(s.effectivePriceE6).toBe(BigInt(SOL_ORACLE.priceE6));
    let n = 0;
    for (const g of GOLDEN.filter((x) => !x.reducing && !x.err)) {
      const size = g.side === "buy" ? BigInt(g.sizeQ) : -BigInt(g.sizeQ);
      const q = quoteView(s, size, 100);
      expect(q.estExecPriceE6, `${g.side} $${g.usd}`).toBe(BigInt(g.execPriceE6!));
      const es = BigInt(g.execSize!);
      expect(q.matcher.fillQ).toBe(es < 0n ? -es : es);
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });
  it("limit price is computeLimitPriceE6 around the engine price at that slippage; withinLimit follows buy <= / sell >=", () => {
    const s = src();
    const size = BigInt(GOLDEN.find((g) => g.side === "buy" && g.usd === 400 && !g.reducing)!.sizeQ);
    for (const bps of [0, 1, 100, 1000]) {
      const b = quoteView(s, size, bps);
      expect(b.limitPriceE6).toBe(computeLimitPriceE6({ markE6: s.effectivePriceE6, size, slippageBps: BigInt(bps) }));
      const sell = quoteView(s, -size, bps);
      expect(sell.limitPriceE6).toBe(computeLimitPriceE6({ markE6: s.effectivePriceE6, size: -size, slippageBps: BigInt(bps) }));
      expect(b.withinLimit).toBe(b.estExecPriceE6! <= b.limitPriceE6);
      expect(sell.withinLimit).toBe(sell.estExecPriceE6! >= sell.limitPriceE6);
    }
    expect(quoteView(s, size, 0).withinLimit).toBe(false); // a 0 bps limit is under the matcher's own spread
    expect(quoteView(s, size, 100).withinLimit).toBe(true);
  });
  it("carries fee bps, max size per side and flags a size above it", () => {
    const s = src();
    const q = quoteView(s, 1n, 100);
    expect(q.baseFeeBps).toBeGreaterThan(0);
    expect(q.feeCapBps === null || q.feeCapBps >= q.baseFeeBps).toBe(true);
    expect(q.maxSizePerSide.long).toHaveProperty("reason");
    const maxQ = q.maxSizePerSide.long.maxQ;
    if (maxQ !== null) {
      expect(quoteView(s, maxQ + 1n, 100).exceedsMaxSize).toBe(true);
      expect(quoteView(s, maxQ, 100).exceedsMaxSize).toBe(false);
    }
  });
  it("depth: asks rise and bids fall with size, ask above bid, spread never shrinks", () => {
    const d = depthView(src());
    expect(d.asks).toHaveLength(DEPTH_LADDER_USD.length);
    expect(d.model).toBe("lp-curve");
    for (let i = 1; i < d.asks.length; i++) {
      expect(d.asks[i].execPriceE6!).toBeGreaterThanOrEqual(d.asks[i - 1].execPriceE6!);
      expect(d.bids[i].execPriceE6!).toBeLessThanOrEqual(d.bids[i - 1].execPriceE6!);
      expect(d.asks[i].spreadBps!).toBeGreaterThanOrEqual(d.asks[i - 1].spreadBps!);
    }
    expect(d.asks[0].execPriceE6!).toBeGreaterThan(d.effectivePriceE6);
    expect(d.bids[0].execPriceE6!).toBeLessThan(d.effectivePriceE6);
    expect(d.asks[d.asks.length - 1].execPriceE6!).toBeGreaterThan(d.asks[0].execPriceE6!); // bigger size is strictly worse somewhere on the ladder
  });
  it("an undecodable matcher context is market_unreadable, not a guess", () => {
    expect(() => buildQuoteSource(raw(SOL_DATA), new Uint8Array(10), raw(LP_DATA), LP, { market: SOL, programId: WRAPPER, slot: SLOT })).toThrowError(expect.objectContaining({ code: "market_unreadable" }));
  });
});

describe("account view on the recorded LP portfolio", () => {
  const scanned = { pubkey: LP, account: { data: LP_DATA } };
  let owner: PublicKey;
  beforeEach(() => {
    owner = parsePortfolio(raw(LP_DATA)).owner;
  });
  const slot = Number(SOL_ORACLE.slot);
  it("lists capital, equity, isLp and the position with entry, mark, liq price, notional, leverage", () => {
    const v = portfolioView(scanned, owner, WRAPPER, { raw: raw(SOL_DATA), programId: WRAPPER }, slot)!;
    expect(v).toMatchObject({ address: LP.toBase58(), market: SOL.toBase58(), isLp: true, marketStatus: "ok" });
    expect(v.capital).toBe(parsePortfolio(raw(LP_DATA)).capital);
    expect(typeof v.equity).toBe("bigint");
    expect(v.positions).toHaveLength(1);
    const p = v.positions[0];
    expect(p.side).toBe("short"); // the LP is short (lpPositionQ < 0)
    expect(p.sizeQ).toBe(BigInt(SOL_ORACLE.lpPositionQ));
    expect(p.markPriceE6).toBe(BigInt(SOL_ORACLE.priceE6));
    expect(p.entrySource).toBe("derived");
    expect(p.entryIsEstimate).toBe(true);
    expect(p.notional).toBe((555540n * BigInt(SOL_ORACLE.priceE6)) / 1_000_000n);
    expect(p.leverage).toBeCloseTo(Number(p.notional) / Number(v.capital), 1);
    expect(p.liqPriceE6).toBeGreaterThan(p.markPriceE6 as bigint); // a short liquidates above the mark
    expect(v.margin).toMatchObject({ initialMarginBps: expect.any(BigInt), maintenanceMarginBps: expect.any(BigInt) });
  });
  it("another wallet's account is never listed; a missing market keeps the portfolio with raw legs only", () => {
    expect(portfolioView(scanned, new PublicKey(new Uint8Array(32).fill(9)), WRAPPER, { raw: raw(SOL_DATA), programId: WRAPPER }, slot)).toBeNull();
    const v = portfolioView(scanned, owner, WRAPPER, null, slot)!;
    expect(v.marketStatus).toBe("missing");
    expect(v.positions[0]).toMatchObject({ side: "short", sizeQ: null, markPriceE6: null });
  });
  it("an undecodable account is skipped", () => {
    expect(portfolioView({ pubkey: LP, account: { data: Buffer.alloc(50) } }, owner, WRAPPER, null, slot)).toBeNull();
  });
});

describe("history merge and params", () => {
  const sig = (n: number, slot: number, extra: Partial<ConfirmedSignatureInfo> = {}): ConfirmedSignatureInfo => ({ signature: `sig${String(n).padStart(3, "0")}`, slot, err: null, memo: null, blockTime: 1_700_000_000 + slot, ...extra });
  it("merges portfolios by slot desc, one row per signature, decodes the error name", () => {
    const failed = sig(2, 90, { err: { InstructionError: [3, { Custom: 49 }] } as never });
    const r = mergeSignatures(
      [
        { portfolio: "A", sigs: [sig(1, 100), failed] },
        { portfolio: "B", sigs: [sig(3, 95), sig(1, 100)] },
      ],
      10,
    );
    expect(r.items.map((i) => i.signature)).toEqual(["sig001", "sig003", "sig002"]);
    expect(r.items[0].portfolios).toEqual(["A", "B"]);
    expect(r.items[2]).toMatchObject({ ok: false, err: { code: 49, name: "EngineInsufficientInitialMargin" } });
    expect(r.items[0]).toMatchObject({ ok: true, err: null, memo: null });
  });
  it("cuts at the limit and says there is more", () => {
    const r = mergeSignatures([{ portfolio: "A", sigs: [sig(1, 100), sig(2, 99), sig(3, 98)] }], 2);
    expect(r.items).toHaveLength(2);
    expect(r.more).toBe(true);
  });
  it("limit 1..100 default 25; before must look like a signature", () => {
    expect(parseLimit(undefined)).toBe(25);
    expect(parseLimit("100")).toBe(100);
    for (const bad of ["0", "101", "-1", "abc", "1.5", ""]) expect(() => parseLimit(bad)).toThrowError(expect.objectContaining({ code: "bad_request" }));
    expect(() => parseBefore("not-a-sig")).toThrowError(expect.objectContaining({ code: "bad_signature" }));
    expect(parseBefore("5".repeat(88))).toBe("5".repeat(88));
  });
});

describe("parsePubkey", () => {
  it("accepts a canonical base58 key and refuses everything else", () => {
    expect(parsePubkey(GATO.toBase58(), "market").equals(GATO)).toBe(true);
    for (const bad of ["", "abc", "0".repeat(44), GATO.toBase58() + "1", "O".repeat(32), undefined, 5]) {
      expect(() => parsePubkey(bad, "market")).toThrowError(expect.objectContaining({ code: "bad_request" }));
    }
  });
});

describe("SSE stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const decoder = new TextDecoder();
  async function drain(stream: ReadableStream<Uint8Array>, advance: () => Promise<void>): Promise<string[]> {
    const reader = stream.getReader();
    const blocks: string[] = [];
    let done = false;
    void (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        blocks.push(decoder.decode(r.value));
      }
      done = true;
    })();
    await advance();
    for (let i = 0; i < 5 && !done; i++) await vi.advanceTimersByTimeAsync(0);
    return blocks;
  }
  const tickOf = (slot: number) => ({ slot, items: [{ market: "M1", snapshot: { market: "M1", effectivePriceE6: 79_000_000n } }, { market: "M2", error: { code: "market_not_found", retryable: false } }] as never });

  it("retry line, market events with id = slot, heartbeat every 10 s, end with reconnect hint at the max duration", async () => {
    let slot = 100;
    const read = vi.fn(async () => tickOf(slot++));
    const blocks = await drain(marketEventStream({ read, maxMs: 25_000 }), () => vi.advanceTimersByTimeAsync(26_000));
    expect(blocks[0]).toBe("retry: 2000\n\n");
    const market = blocks.filter((b) => b.startsWith("event: market"));
    expect(market[0]).toMatch(/^event: market\nid: 100\ndata: \{"market":"M1","effectivePriceE6":"79000000","slot":100,"observedAt":"[^"]+"\}\n\n$/);
    expect(market[1]).toContain('"error":{"code":"market_not_found","retryable":false}'); // second market in the same tick
    expect(market.length).toBeGreaterThanOrEqual(2 * 12); // one read at 0 s and every 2 s up to 24 s
    const beats = blocks.filter((b) => b.startsWith("event: heartbeat"));
    expect(beats).toHaveLength(2); // at 10 s and 20 s
    expect(beats[0]).toMatch(/^event: heartbeat\nid: \d+\ndata: \{"slot":\d+,"observedAt":"[^"]+"\}\n\n$/);
    const last = blocks[blocks.length - 1];
    expect(last).toMatch(/^event: end\ndata: \{"reason":"max-duration","reconnect":true,"lastEventId":"\d+"\}\n\n$/);
    const callsAtEnd = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.length).toBe(callsAtEnd); // closed: no more reads
  });
  it("a failed read is an error event and the stream stays open", async () => {
    let n = 0;
    const read = vi.fn(async () => {
      if (n++ === 0) throw new ApiError("rpc_unavailable");
      return tickOf(200);
    });
    const blocks = await drain(marketEventStream({ read, maxMs: 5_000 }), () => vi.advanceTimersByTimeAsync(6_000));
    expect(blocks[1]).toBe('event: error\ndata: {"code":"rpc_unavailable","retryable":true}\n\n');
    expect(blocks.some((b) => b.startsWith("event: market"))).toBe(true);
  });
  it("never sends a snapshot older than the Last-Event-ID the client resumed with", async () => {
    const slots = [90, 120];
    const read = vi.fn(async () => tickOf(slots.shift() ?? 130));
    const blocks = await drain(marketEventStream({ read, maxMs: 3_000, lastEventId: 100 }), () => vi.advanceTimersByTimeAsync(4_000));
    const ids = blocks.filter((b) => b.startsWith("event: market")).map((b) => Number(/id: (\d+)/.exec(b)![1]));
    expect(ids.length).toBeGreaterThan(0);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(100);
    expect(parseLastEventId("123")).toBe(123);
    expect(parseLastEventId("12x")).toBeNull();
    expect(parseLastEventId(null)).toBeNull();
  });
  it("stops reading when the client goes away", async () => {
    const read = vi.fn(async () => tickOf(1));
    const ac = new AbortController();
    const stream = marketEventStream({ read, maxMs: 55_000, signal: ac.signal });
    const reader = stream.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(4_100);
    ac.abort();
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read.mock.calls.length).toBe(calls);
  });
});

describe("council fixes: quote and market shape", () => {
  const SLOT = Number(SOL_ORACLE.slot);
  const src = (slot = SLOT) => buildQuoteSource(raw(SOL_DATA), raw(CTX_DATA), raw(LP_DATA), LP, { market: SOL, programId: WRAPPER, slot });
  const size = () => BigInt(GOLDEN.find((g) => g.side === "buy" && g.usd === 400 && !g.reducing)!.sizeQ);

  it("clerk F2 / first-timer F5: the quote and depth carry the oracle freshness the market read exposes", () => {
    const fresh = src();
    expect(quoteView(fresh, size(), 100).oracle).toEqual({ stale: false, ageSecs: expect.any(Number), staleBoundSecs: expect.any(Number) });
    const view = decodeMarket(raw(SOL_DATA), { market: SOL, programId: WRAPPER, slot: SLOT });
    expect(quoteView(fresh, size(), 100).oracle.stale).toBe(view.oracle.stale);
    const late = src(SLOT + 1_000_000);
    expect(quoteView(late, size(), 100).oracle.stale).toBe(true);
    expect(depthView(late).oracle.stale).toBe(true);
  });
  it("first-timer F6: bps on the wire are JSON numbers, the schema says so (no bigint left in a *Bps analytics field)", () => {
    const q = JSON.parse(JSON.stringify(quoteView(src(), size(), 100), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    for (const v of [q.priceImpactBps, q.totalSpreadBps, q.matcher.adaptiveFeeBps, q.matcher.skewBps, q.matcher.baseSpreadBps, q.matcher.maxTotalBps, q.feeCapBps, q.baseFeeBps, q.expectedFeeBps]) {
      expect(typeof v === "number" || v === null).toBe(true);
    }
    const d = JSON.parse(JSON.stringify(depthView(src()), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    for (const r of [...d.asks, ...d.bids]) for (const v of [r.spreadBps, r.impactBps]) expect(typeof v === "number" || v === null).toBe(true);
  });
  it("trader (b): expected fee is base + adaptive request, in bps and atoms, and never above the cap", () => {
    const q = quoteView(src(), size(), 100);
    expect(q.expectedFeeBps).toBe(q.baseFeeBps + (q.matcher.adaptiveFeeBps ?? 0));
    expect(q.expectedFeeBps!).toBeLessThanOrEqual(q.feeCapBps!);
    expect(q.expectedFeeAtoms).toBe((q.notionalAtoms * BigInt(q.expectedFeeBps!) + 9_999n) / 10_000n);
  });
  it("trader (f): nothing filled means no price, impact or spread (not 0)", () => {
    const s = src();
    // A halted LP: the matcher context has no capacity. Force it through the source's context.
    const halted = { ...s, ctx: { ...s.ctx, maxFillAbs: 0n } };
    const q = quoteView(halted, size(), 100);
    if (q.matcher.fillQ === 0n) {
      expect(q).toMatchObject({ estExecPriceE6: null, priceImpactBps: null, totalSpreadBps: null, withinLimit: null, expectedFeeBps: null, expectedFeeAtoms: null });
      expect(depthView(halted).asks.every((r) => r.execPriceE6 === null && r.spreadBps === null && r.impactBps === null)).toBe(true);
    } else {
      throw new Error("fixture did not produce a zero fill; adjust the halted context");
    }
  });
  it("attacker / first-timer F2: the market carries its collateral mint and decimals", () => {
    const v = decodeMarket(raw(SOL_DATA), { market: SOL, programId: WRAPPER, slot: SLOT });
    expect(v).toMatchObject({ collateralMint: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC", collateralDecimals: 6 });
  });
  it("risk F5: account leverage is notional over the same conservative equity the order cap uses", () => {
    const wallet = parsePortfolio(raw(LP_DATA)).owner;
    const v = portfolioView({ pubkey: LP, account: { data: LP_DATA } }, wallet, WRAPPER, { raw: raw(SOL_DATA), programId: WRAPPER }, SLOT)!;
    const p = v.positions[0];
    expect(v.leverageEquity).toBeLessThanOrEqual(v.capital + (v.feeCredits > 0n ? 0n : v.feeCredits));
    expect(p.leverage).toBe(Number((p.notional! * 100n) / v.leverageEquity) / 100);
  });
});

describe("trader (d): liquidation price with the engine's minimum maintenance margin", () => {
  it("a small long is liquidated where the floor binds, not at the percentage price (the trader seat's case: 29.99 -> about 32.19)", () => {
    // entry 68.79, capital 10.149520 USD, q 0.249999, mm 600 bps -> percentage price 29.988320; floor 1.000000 USD
    const v = liqPriceWithMmFloor(29_988_320n, 68_790_000n, 10_149_520n, 249_999n, 1_000_000n)!;
    expect(v).toBeGreaterThan(32_100_000n);
    expect(v).toBeLessThan(32_300_000n);
    // at that price the position's equity equals the floor (within one q-unit of rounding)
    const equity = 10_149_520n + (249_999n * (v - 68_790_000n)) / 1_000_000n;
    expect(equity - 1_000_000n < 5n && equity - 1_000_000n > -5n).toBe(true);
  });
  it("leaves the percentage price alone when the floor is lower, absent, or the leg is flat", () => {
    expect(liqPriceWithMmFloor(85_106_000n, 100_000_000n, 20_000_000n, 1_000_000n, 1_000_000n)).toBe(85_106_000n); // floor line 81.0 < 85.1
    expect(liqPriceWithMmFloor(85_106_000n, 100_000_000n, 20_000_000n, 1_000_000n, 0n)).toBe(85_106_000n);
    expect(liqPriceWithMmFloor(85_106_000n, 100_000_000n, 20_000_000n, 0n, 5_000_000n)).toBe(85_106_000n);
    expect(liqPriceWithMmFloor(null, 100_000_000n, 20_000_000n, 1_000_000n, 5_000_000n)).toBeNull();
  });
  it("long: the higher of the two prices; a long covered at any price (0) still has the floor price", () => {
    expect(liqPriceWithMmFloor(85_106_000n, 100_000_000n, 20_000_000n, 1_000_000n, 10_000_000n)).toBe(90_000_000n);
    expect(liqPriceWithMmFloor(0n, 100_000_000n, 20_000_000n, 1_000_000n, 10_000_000n)).toBe(90_000_000n);
  });
  it("short: the lower of the two prices", () => {
    // short 1 unit at 100, capital 20: percentage price 100 + 20 = 120/(1+0.06) = 113.2; floor 10 -> 110
    expect(liqPriceWithMmFloor(113_207_547n, 100_000_000n, 20_000_000n, -1_000_000n, 10_000_000n)).toBe(110_000_000n);
  });
});
