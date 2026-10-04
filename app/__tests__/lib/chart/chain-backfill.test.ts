// @vitest-environment node
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { MemoryCandleStore } from "@/lib/chart/candle-store";
import {
  MemoryProgressStore, decodePushAuthMark, extractPushes, runChainBackfill,
  type ChainRpc, type RpcTx, type SigInfo,
} from "@/lib/chart/chain-backfill";

const PROGRAM = "ETDLAdiAprogram11111111111111111111111111111";
const AUTH = "KeeperAuth111111111111111111111111111111111";
const A = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const B = "6Y4bfYLWrhabgzU4p3onx9CeW1jCKjGjjSCaoCHf2Q9R";
const OTHER = "CzKfk54TNja7UQFyDrHfad8pKSU3QkteZhDhQwkSLDcQ";
const T0 = Math.floor(Date.UTC(2026, 9, 3, 12, 0, 0) / 1000);

function pushData(markE6: bigint, opts: { tag?: number; len?: number; asset?: number } = {}): string {
  const full = new Uint8Array(35);
  const b = full;
  const dv = new DataView(b.buffer);
  b[0] = opts.tag ?? 63;
  dv.setUint16(1, opts.asset ?? 0, true);
  dv.setBigUint64(3, 7n, true);
  dv.setBigUint64(11, 123n, true);
  dv.setBigUint64(19, markE6, true);
  dv.setBigUint64(27, 9n, true);
  return bs58.encode(opts.len !== undefined ? full.slice(0, opts.len) : full);
}

interface Push { slab: string; markE6: bigint; asset?: number; program?: string; tag?: number }
function mkTx(slot: number, blockTime: number | null, pushes: Push[], over: { err?: unknown } = {}): RpcTx {
  const keys = [AUTH, "ComputeBudget111111111111111111111111111111", PROGRAM, "SomeOtherProgram11111111111111111111111111"];
  const slabIdx = new Map<string, number>();
  const ixs = pushes.map((p) => {
    if (!slabIdx.has(p.slab)) { slabIdx.set(p.slab, keys.length); keys.push(p.slab); }
    return { programIdIndex: p.program === "other" ? 3 : 2, accounts: [0, slabIdx.get(p.slab)!], data: pushData(p.markE6, { asset: p.asset, tag: p.tag }) };
  });
  return { slot, blockTime, meta: { err: over.err ?? null }, transaction: { message: { accountKeys: keys, instructions: ixs } } };
}

function fakeChain(txs: Array<{ sig: string; tx: RpcTx }>, opts: { failSigs?: Set<string> } = {}) {
  const calls = { sigs: 0, tx: 0 };
  const infos: SigInfo[] = txs.map((t) => ({ signature: t.sig, slot: t.tx.slot, blockTime: t.tx.blockTime, err: t.tx.meta?.err ?? null })).reverse(); // newest first
  const rpc: ChainRpc = {
    async getSignatures(_a, before, limit) {
      calls.sigs++;
      const start = before ? infos.findIndex((i) => i.signature === before) + 1 : 0;
      return infos.slice(start, start + limit);
    },
    async getTransactions(sigs) {
      calls.tx += sigs.length;
      return sigs.map((s) => (opts.failSigs?.has(s) ? null : txs.find((t) => t.sig === s)?.tx ?? null));
    },
  };
  return { rpc, calls };
}

const NOW = () => (T0 + 86_400) * 1000;
const baseOpts = { slabs: [A, B], authority: AUTH, programId: PROGRAM, chunk: 3 };

describe("decodePushAuthMark", () => {
  it("decodes the 35-byte instruction", () => {
    const d = decodePushAuthMark(bs58.decode(pushData(3690n)))!;
    expect(d).toMatchObject({ assetIndex: 0, marketId: 7n, nowSlot: 123n, markE6: 3690n, observationSequence: 9n });
  });
  it("rejects wrong tag, wrong length, zero price (negative controls)", () => {
    expect(decodePushAuthMark(bs58.decode(pushData(1n, { tag: 62 })))).toBeNull();
    expect(decodePushAuthMark(bs58.decode(pushData(1n, { len: 34 })))).toBeNull();
    expect(decodePushAuthMark(bs58.decode(pushData(0n)))).toBeNull();
  });
});

describe("extractPushes", () => {
  it("pulls every push in a batched tx with its market", () => {
    const out = extractPushes(mkTx(10, T0, [{ slab: A, markE6: 100n }, { slab: B, markE6: 200n }]), PROGRAM);
    expect(out.map((p) => [p.slab, p.markE6, p.slot, p.blockTime])).toEqual([[A, 100n, 10, T0], [B, 200n, 10, T0]]);
  });
  it("ignores a failed tx, another program, a non-push ix, a missing blockTime", () => {
    expect(extractPushes(mkTx(1, T0, [{ slab: A, markE6: 1n }], { err: { InstructionError: [1, "x"] } }), PROGRAM)).toEqual([]);
    expect(extractPushes(mkTx(1, T0, [{ slab: A, markE6: 1n, program: "other" }]), PROGRAM)).toEqual([]);
    expect(extractPushes(mkTx(1, T0, [{ slab: A, markE6: 1n, tag: 5 }]), PROGRAM)).toEqual([]);
    expect(extractPushes(mkTx(1, null, [{ slab: A, markE6: 1n }]), PROGRAM)).toEqual([]);
  });
  it("resolves accounts through loaded (lookup-table) addresses", () => {
    const tx = mkTx(1, T0, [{ slab: A, markE6: 5n }]);
    const keys = tx.transaction.message.accountKeys;
    const i = keys.indexOf(A);
    keys.splice(i, 1); // the slab now lives in the lookup table
    tx.meta!.loadedAddresses = { writable: [A], readonly: [] };
    tx.transaction.message.instructions[0].accounts = [0, keys.length];
    expect(extractPushes(tx, PROGRAM)[0].slab).toBe(A);
  });
});

/** A 3-minute history for A (mark 100 -> 130) and B. */
function history() {
  const txs: Array<{ sig: string; tx: RpcTx }> = [];
  for (let i = 0; i < 40; i++) {
    txs.push({ sig: `sig${String(i).padStart(3, "0")}`, tx: mkTx(100 + i, T0 + i * 5, [{ slab: A, markE6: BigInt(100 + i) }, { slab: B, markE6: BigInt(500 + i) }]) });
  }
  return txs;
}

describe("runChainBackfill", () => {
  it("rebuilds mark candles from the pushes (open, high, low, close, continuity) as src=chain", async () => {
    const store = new MemoryCandleStore();
    const { rpc } = fakeChain(history());
    const s = await runChainBackfill(baseOpts, { rpc, store, progress: new MemoryProgressStore(), now: NOW });
    expect(s).toMatchObject({ status: "done", pushes: 80 });
    const m1 = await store.range(A, "mark", 1, 0, 4e9, 100);
    expect(m1.every((c) => c.src === "chain")).toBe(true);
    expect(m1[0]).toMatchObject({ t: T0, o: 0.0001, h: 0.000111, l: 0.0001, c: 0.000111, n: 12 });
    expect(m1[1].o).toBe(m1[0].c); // continuity
    expect(await store.range(A, "oracle", 1, 0, 4e9, 10)).toEqual([]); // oracle series untouched
    expect((await store.range(B, "mark", 5, 0, 4e9, 10))[0].o).toBe(0.0005);
  });

  it("is idempotent: a second full run (restart) produces identical rows", async () => {
    const store = new MemoryCandleStore();
    const mk = () => ({ rpc: fakeChain(history()).rpc, store, progress: new MemoryProgressStore(), now: NOW });
    await runChainBackfill(baseOpts, mk());
    const first = JSON.stringify([...store.rows.entries()].sort());
    await runChainBackfill({ ...baseOpts, restart: true }, mk());
    expect(JSON.stringify([...store.rows.entries()].sort())).toBe(first);
  });

  it("a finished run is a no-op without restart (negative control: restart redoes it)", async () => {
    const store = new MemoryCandleStore();
    const progress = new MemoryProgressStore();
    const f = fakeChain(history());
    await runChainBackfill(baseOpts, { rpc: f.rpc, store, progress, now: NOW });
    const before = f.calls.tx;
    expect((await runChainBackfill(baseOpts, { rpc: f.rpc, store, progress, now: NOW })).status).toBe("already-done");
    expect(f.calls.tx).toBe(before);
    expect((await runChainBackfill({ ...baseOpts, restart: true }, { rpc: f.rpc, store, progress, now: NOW })).status).toBe("done");
    expect(f.calls.tx).toBeGreaterThan(before);
  });

  it("is resumable: stopping after 4 chunks then resuming equals one uninterrupted run, and does not refetch", async () => {
    const whole = new MemoryCandleStore();
    await runChainBackfill(baseOpts, { rpc: fakeChain(history()).rpc, store: whole, progress: new MemoryProgressStore(), now: NOW });

    const store = new MemoryCandleStore();
    const progress = new MemoryProgressStore();
    const f = fakeChain(history());
    const part = await runChainBackfill({ ...baseOpts, maxChunks: 4 }, { rpc: f.rpc, store, progress, now: NOW });
    expect(part.status).toBe("partial");
    expect(f.calls.tx).toBe(12);
    const rest = await runChainBackfill(baseOpts, { rpc: f.rpc, store, progress, now: NOW });
    expect(rest.status).toBe("done");
    expect(f.calls.tx).toBe(40); // 12 + the remaining 28, none twice
    expect(JSON.stringify([...store.rows.entries()].sort())).toBe(JSON.stringify([...whole.rows.entries()].sort()));
  });

  it("stops at each market's live cutover; the straddling bucket merges instead of being overwritten", async () => {
    const store = new MemoryCandleStore();
    // The live feed started in minute T0+60: its first 1m candle and the 5m candle that contains it.
    await store.upsert([
      { slab: A, series: "mark", res: 1, candle: { t: T0 + 60, o: 0.9, h: 0.95, l: 0.85, c: 0.92, n: 4 } },
      { slab: A, series: "mark", res: 5, candle: { t: T0, o: 0.9, h: 0.95, l: 0.85, c: 0.92, n: 4 } },
    ]);
    const f = fakeChain(history());
    const s = await runChainBackfill(baseOpts, { rpc: f.rpc, store, progress: new MemoryProgressStore(), now: NOW });
    expect(s.skippedLive).toBeGreaterThan(0);
    const rows = await store.range(A, "mark", 1, 0, 4e9, 100);
    expect(rows.find((c) => c.t === T0 + 60)).toMatchObject({ src: "live", o: 0.9, c: 0.92 }); // the live minute is untouched
    expect(rows.filter((c) => c.t > T0 + 60)).toEqual([]); // nothing chain-built after the cutover
    expect(rows.filter((c) => c.t < T0 + 60).every((c) => c.src === "chain")).toBe(true);
    // The 5m bucket straddles the cutover: chain open + live close, widened high/low, summed ticks.
    const m5 = (await store.range(A, "mark", 5, 0, 4e9, 10))[0];
    expect(m5).toMatchObject({ src: "live", o: 0.0001, h: 0.95, c: 0.92 });
    expect(m5.l).toBe(0.0001);
  });

  it("skips failed signatures, unknown markets, assetIndex != 0 and null txs; never writes older than retention", async () => {
    const txs = [
      { sig: "s1", tx: mkTx(1, T0, [{ slab: A, markE6: 100n }, { slab: OTHER, markE6: 999n }, { slab: B, markE6: 5n, asset: 1 }]) },
      { sig: "s2", tx: mkTx(2, T0 + 1, [{ slab: A, markE6: 777n }], { err: { x: 1 } }) },
      { sig: "s3", tx: mkTx(3, T0 + 2, [{ slab: A, markE6: 150n }]) },
    ];
    const store = new MemoryCandleStore();
    const f = fakeChain(txs, { failSigs: new Set(["s3"]) });
    await runChainBackfill({ ...baseOpts, chunk: 10 }, { rpc: f.rpc, store, progress: new MemoryProgressStore(), now: () => (T0 + 10 * 86_400) * 1000 });
    expect((await store.range(A, "mark", 1440, 0, 4e9, 10))[0]).toMatchObject({ o: 0.0001, c: 0.0001 }); // 777 (failed) and 150 (null tx) excluded
    expect(await store.range(OTHER, "mark", 1440, 0, 4e9, 10)).toEqual([]);
    expect(await store.range(B, "mark", 1440, 0, 4e9, 10)).toEqual([]);
    // T0 is 10 days before NOW: the 1m (2 d) and 5m (7 d) buckets are past retention, 15m (21 d) and 1D are kept.
    expect(await store.range(A, "mark", 1, 0, 4e9, 10)).toEqual([]);
    expect(await store.range(A, "mark", 5, 0, 4e9, 10)).toEqual([]);
    expect((await store.range(A, "mark", 15, 0, 4e9, 10)).length).toBe(1);
  });

  it("dry-run lists and counts but fetches and writes nothing", async () => {
    const store = new MemoryCandleStore();
    const f = fakeChain(history());
    const s = await runChainBackfill({ ...baseOpts, dryRun: true }, { rpc: f.rpc, store, progress: new MemoryProgressStore(), now: NOW });
    expect(s).toMatchObject({ status: "dry-run", listed: 40 });
    expect(f.calls.tx).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("sinceSec bounds the listing", async () => {
    const f = fakeChain(history());
    const s = await runChainBackfill({ ...baseOpts, dryRun: true, sinceSec: T0 + 100 }, { rpc: f.rpc, store: new MemoryCandleStore(), progress: new MemoryProgressStore(), now: NOW });
    expect(s.listed).toBe(20); // pushes at T0+100..T0+195 (i = 20..39)
  });

  it("sampleSeconds keeps only txs in the first N seconds of each minute; unset keeps all (negative control)", async () => {
    const many: Array<{ sig: string; tx: RpcTx }> = [];
    for (let i = 0; i < 120; i++) many.push({ sig: `q${i}`, tx: mkTx(i + 1, T0 + i, [{ slab: A, markE6: 100n }]) }); // T0 is minute-aligned
    const run = (o: object) => runChainBackfill({ ...baseOpts, dryRun: true, ...o }, { rpc: fakeChain(many).rpc, store: new MemoryCandleStore(), progress: new MemoryProgressStore(), now: NOW });
    expect((await run({})).listed).toBe(120);
    expect((await run({ sampleSeconds: 20 })).listed).toBe(40); // 20 of every 60 seconds
  });

  it("pages the signature listing (more than one page)", async () => {
    const many: Array<{ sig: string; tx: RpcTx }> = [];
    for (let i = 0; i < 2500; i++) many.push({ sig: `m${i}`, tx: mkTx(i + 1, T0 + i, [{ slab: A, markE6: 100n }]) });
    const f = fakeChain(many);
    const s = await runChainBackfill({ ...baseOpts, dryRun: true }, { rpc: f.rpc, store: new MemoryCandleStore(), progress: new MemoryProgressStore(), now: NOW });
    expect(s.listed).toBe(2500);
    expect(f.calls.sigs).toBe(4); // 1000 + 1000 + 500, then the empty page that ends the listing
  });

  it("a short page mid-history does not end the listing (negative control for the page-size shortcut)", async () => {
    const many: Array<{ sig: string; tx: RpcTx }> = [];
    for (let i = 0; i < 300; i++) many.push({ sig: `m${i}`, tx: mkTx(i + 1, T0 + i, [{ slab: A, markE6: 100n }]) });
    const base = fakeChain(many);
    const short: ChainRpc = { ...base.rpc, getSignatures: async (a, b, l) => base.rpc.getSignatures(a, b, Math.min(l, 100)) };
    const s = await runChainBackfill({ ...baseOpts, dryRun: true }, { rpc: short, store: new MemoryCandleStore(), progress: new MemoryProgressStore(), now: NOW });
    expect(s.listed).toBe(300);
  });

  it("drops a push whose slot goes backwards for a market (a late tx cannot rewrite earlier bars)", async () => {
    const txs = [
      { sig: "a", tx: mkTx(50, T0, [{ slab: A, markE6: 100n }]) },
      { sig: "b", tx: mkTx(40, T0 + 1, [{ slab: A, markE6: 900n }]) },
    ];
    const store = new MemoryCandleStore();
    const f = fakeChain(txs);
    // both in one chunk: processed in slot order, so the slot-40 push comes FIRST and the slot-50 one is later: both valid.
    await runChainBackfill({ ...baseOpts, chunk: 10 }, { rpc: f.rpc, store, progress: new MemoryProgressStore(), now: NOW });
    const d = (await store.range(A, "mark", 1440, 0, 4e9, 10))[0];
    expect(d.h).toBe(0.0009);
    expect(d.c).toBe(0.0001);
  });
});

import { createHttpRpc } from "@/lib/chart/chain-rpc";

describe("createHttpRpc", () => {
  const resp = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body });

  it("never exceeds the request rate (a batch of N costs N slots)", async () => {
    let t = 1_000_000;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: { body: string }) => {
      starts.push(t);
      const reqs = JSON.parse(init.body) as Array<{ id: number }>;
      return resp(200, reqs.map((r) => ({ id: r.id, result: null })));
    });
    const rpc = createHttpRpc({ url: "https://rpc.example/?api-key=SECRET", rps: 10, batch: 5, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t, sleep: async (ms) => { t += ms; } });
    await rpc.getTransactions(Array.from({ length: 50 }, (_, i) => `s${i}`));
    expect(rpc.requests()).toBe(50);
    // 50 requests at 10/s: at least ~4.5 s of simulated time between the first and last batch start.
    expect(starts.at(-1)! - starts[0]).toBeGreaterThanOrEqual(4_400);
  });
  it("backs off on 429 and recovers; gives up after the retry cap without leaking the URL", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let n = 0;
    const flaky = vi.fn(async () => (n++ < 2 ? resp(429, {}, { "retry-after": "2" }) : resp(200, { result: [] })));
    const ok = createHttpRpc({ url: "https://rpc.example/?api-key=SECRET", fetchImpl: flaky as unknown as typeof fetch, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    expect(await ok.getSignatures(A, undefined, 10)).toEqual([]);
    expect(sleeps.filter((s) => s >= 2000).length).toBe(2);
    const dead = createHttpRpc({ url: "https://rpc.example/?api-key=SECRET", maxRetries: 2, fetchImpl: (async () => resp(500, {})) as unknown as typeof fetch, now: () => t, sleep: async () => {} });
    await expect(dead.getSignatures(A, undefined, 10)).rejects.toThrow(/rpc http 500/);
    await dead.getSignatures(A, undefined, 10).catch((e: Error) => expect(e.message).not.toContain("SECRET"));
  });
  it("a non-retryable 4xx fails immediately", async () => {
    const f = vi.fn(async () => resp(401, {}));
    const rpc = createHttpRpc({ url: "https://x", fetchImpl: f as unknown as typeof fetch, sleep: async () => {} });
    await expect(rpc.getSignatures(A, undefined, 1)).rejects.toThrow(/401/);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

import { resolveBackfillRpc } from "@/lib/chart/chain-rpc";
describe("resolveBackfillRpc", () => {
  it("prefers explicit URL, then the dedicated charts key, then the keeper key (flagged)", () => {
    expect(resolveBackfillRpc({ CHAIN_RPC_URL: "https://x/y", HELIUS_CHARTS_API_KEY: "c" })).toEqual({ url: "https://x/y", usedKeeperKey: false });
    expect(resolveBackfillRpc({ HELIUS_CHARTS_API_KEY: "charts", HELIUS_KEEPER_API_KEY: "keeper" })).toEqual({ url: "https://devnet.helius-rpc.com/?api-key=charts", usedKeeperKey: false });
    expect(resolveBackfillRpc({ CHART_BACKFILL_HELIUS_KEY: "dedicated", HELIUS_CHARTS_API_KEY: "charts" })!.url).toContain("dedicated");
    expect(resolveBackfillRpc({ HELIUS_KEEPER_API_KEY: "keeper" })).toEqual({ url: "https://devnet.helius-rpc.com/?api-key=keeper", usedKeeperKey: true });
  });
  it("is null with nothing configured (negative control), and ignores blank values", () => {
    expect(resolveBackfillRpc({})).toBeNull();
    expect(resolveBackfillRpc({ HELIUS_CHARTS_API_KEY: "  ", CHAIN_RPC_URL: "" })).toBeNull();
  });
});
