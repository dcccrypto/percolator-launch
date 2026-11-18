import { appendFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { txNamesProgram, orderDeltas, type ChainDelta } from "@/lib/entry-chain";

// Copies of the pre-optimisation implementations (ffb64d77), kept as the differential oracle.
function oldTxNamesProgram(tx: any, program: PublicKey): boolean {
  const m = tx?.transaction?.message;
  const keys = m?.staticAccountKeys ?? m?.accountKeys;
  if (!keys) return true;
  const eq = (k: unknown): boolean => {
    if (k instanceof Object && typeof (k as PublicKey).equals === "function") return (k as PublicKey).equals(program);
    return typeof k === "string" && k === program.toBase58();
  };
  if (keys.some(eq)) return true;
  const la = tx?.meta?.loadedAddresses;
  return !!la && [...(la.writable ?? []), ...(la.readonly ?? [])].some(eq);
}
function oldOrder(out: ChainDelta[], reduces: { at: number; d: ChainDelta }[], fillAt: number, fillDelta: ChainDelta | null) {
  for (const r of reduces.filter((r) => r.at < fillAt || fillAt < 0)) out.push(r.d);
  if (fillDelta) out.push(fillDelta);
  for (const r of reduces.filter((r) => fillAt >= 0 && r.at > fillAt)) out.push(r.d);
}

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const program = Keypair.generate().publicKey;
const pool = Array.from({ length: 64 }, () => Keypair.generate().publicKey);
const b58Of = new Map<PublicKey, string>([...pool, program].map((k) => [k, k.toBase58()]));

function makeTxs(n: number, seed: number) {
  const r = rng(seed);
  const txs: any[] = [];
  const key = (hit: boolean) => {
    const pk = hit ? program : pool[Math.floor(r() * pool.length)];
    return r() < 0.5 ? pk : b58Of.get(pk)!;
  };
  for (let i = 0; i < n; i++) {
    const len = 10 + Math.floor(r() * 31);
    const hit = r() < 0.3;
    const keys = Array.from({ length: len }, () => key(false));
    const la = r() < 0.5;
    const loaded = la ? { writable: Array.from({ length: 5 }, () => key(false)), readonly: Array.from({ length: 5 }, () => key(false)) } : null;
    if (hit) {
      if (r() < 0.4 || !loaded) keys[Math.floor(r() * len)] = key(true);
      else (r() < 0.5 ? loaded.writable : loaded.readonly)[Math.floor(r() * 5)] = key(true);
    }
    const shape = r();
    const message = shape < 0.1 ? undefined : shape < 0.2 ? { accountKeys: keys } : { staticAccountKeys: keys };
    txs.push({ transaction: message === undefined ? {} : { message }, meta: la ? { loadedAddresses: loaded } : r() < 0.5 ? null : {} });
  }
  txs.push(null, {}, { transaction: { message: { staticAccountKeys: [] } }, meta: { loadedAddresses: { writable: [], readonly: undefined } } });
  return txs;
}

describe("txNamesProgram / orderDeltas differential", () => {
  it("matches the old implementation on 2,000-tx fixtures x 5 seeds", () => {
    let mismatches = 0, hits = 0;
    for (const seed of [1, 2, 3, 99, 12345]) for (const tx of makeTxs(2000, seed)) {
      const a = oldTxNamesProgram(tx, program), b = txNamesProgram(tx, program);
      if (a !== b) mismatches++;
      if (a) hits++;
    }
    expect(mismatches).toBe(0);
    expect(hits).toBeGreaterThan(1000);
  }, 300_000);
  it("orders reduces identically around the fill", () => {
    const r = rng(7);
    let mismatches = 0;
    for (let t = 0; t < 2000; t++) {
      const n = Math.floor(r() * 30);
      const reduces = Array.from({ length: n }, (_, i) => ({ at: i * 2 + (r() < 0.1 ? 1 : 0), d: { sig: "s" + i, deltaQ: BigInt(i) } as ChainDelta }));
      const fillAt = r() < 0.3 ? -1 : Math.floor(r() * (n * 2 + 1));
      const fd = r() < 0.7 ? ({ sig: "f", deltaQ: 1n } as ChainDelta) : null;
      const o1: ChainDelta[] = [], o2: ChainDelta[] = [];
      oldOrder(o1, reduces, fillAt, fd); orderDeltas(o2, reduces, fillAt, fd);
      if (o1.length !== o2.length || o1.some((d, i) => d !== o2[i])) mismatches++;
    }
    expect(mismatches).toBe(0);
  });
});

describe.skipIf(!process.env.BENCH)("bench", () => {
  it("old vs new", { timeout: 300_000 }, () => {
    const txs = makeTxs(2000, 42);
    const time = (f: () => void, reps: number) => { f(); const t = process.hrtime.bigint(); for (let i = 0; i < reps; i++) f(); return Number(process.hrtime.bigint() - t) / reps; };
    const per = (fn: (t: any, p: PublicKey) => boolean) => time(() => { for (const t of txs) fn(t, program); }, 3) / txs.length;
    const chain = Array.from({ length: 500 }, (_, i) => ({ at: i * 2, d: { sig: "s" + i, deltaQ: 1n } as ChainDelta }));
    const perChain = (fn: typeof oldOrder) => time(() => fn([], chain, 500, { sig: "f", deltaQ: 1n } as ChainDelta), 20000);
    const log = (m: string) => { if (process.env.BENCH_OUT) appendFileSync(process.env.BENCH_OUT, m + "\n"); };
    log(`BENCH txNamesProgram ns/tx old=${per(oldTxNamesProgram).toFixed(1)} new=${per(txNamesProgram).toFixed(1)}`);
    log(`BENCH reduce-split ns/chain(500) old=${perChain(oldOrder).toFixed(0)} new=${perChain(orderDeltas).toFixed(0)}`);
  });
});
