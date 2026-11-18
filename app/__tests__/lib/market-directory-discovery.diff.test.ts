/**
 * Differential test: the single-encode implementation must match the frozen legacy copy on owned
 * list, infos served to getMarketsByAddress, and fall-through calls, for 2,000 random inputs
 * (duplicates, invalid keys, foreign program ids, unowned/null accounts).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

type Trace = { owned: string[]; served: unknown[]; fall: string[][] };
let trace: Trace;
const mockGet = vi.hoisted(() => ({
  fn: async (_c: any, _p: any, _o: any) => [] as any[],
}));
vi.mock("@/lib/v22/discovery", () => ({
  getMarketsByAddress: (c: any, p: any, o: any) => mockGet.fn(c, p, o),
}));

import { discoverMarketsViaProgramDirectory as fresh } from "@/lib/market-directory-discovery";
import { discoverMarketsViaProgramDirectory as legacy } from "./market-directory-discovery.legacy";

// deterministic PRNG
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("market-directory-discovery differential", () => {
  it("matches legacy on 2000 random inputs", async () => {
    const rand = rng(12345);
    const programId = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const pool = Array.from({ length: 300 }, () => Keypair.generate().publicKey.toBase58());
    const unknown = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    let mismatches = 0;

    for (let iter = 0; iter < (Number(process.env.DIFF_ITERS) || 2000); iter++) {
      const n = Math.floor(rand() * 130); // spans 0..2+ batches of 100
      const rows: any[] = [];
      for (let i = 0; i < n; i++) {
        const r = rand();
        if (r < 0.06) rows.push({ slab_address: "not-a-key!" + i, program_id: programId.toBase58() });
        else if (r < 0.1) rows.push({ slab_address: 12, program_id: programId.toBase58() });
        else if (r < 0.15) rows.push({ slab_address: pick(pool), program_id: other.toBase58() });
        else if (r < 0.2) rows.push({ slab_address: pick(pool) }); // no program_id
        else rows.push({ slab_address: pick(pool), program_id: programId.toBase58() });
      }
      // per-key account state, shared across both runs
      const state = new Map<string, any>();
      const infoFor = (k: string) => {
        if (!state.has(k)) {
          const r = rand();
          state.set(k, r < 0.15 ? null : { owner: r < 0.3 ? other : programId, lamports: Math.floor(rand() * 1e6), data: Buffer.alloc(0) });
        }
        return state.get(k);
      };
      const extra = pick(unknown); // drawn once so both runs see the same input
      const mode = iter % 3; // 0: same objects, 1: cloned objects, 2: owned + unknown key

      const run = async (impl: typeof fresh): Promise<Trace> => {
        const t: Trace = { owned: [], served: [], fall: [] };
        let initial = true;
        const conn: any = {
          getMultipleAccountsInfo: async (ks: PublicKey[]) => {
            const b = ks.map((k) => k.toBase58());
            if (!initial) t.fall.push(b);
            return b.map((k) => infoFor(k));
          },
          other: () => "passthrough",
        };
        mockGet.fn = async (c: any, _p: any, owned: PublicKey[]) => {
          initial = false;
          t.owned = owned.map((k) => k.toBase58());
          const keys =
            mode === 0 ? owned : mode === 1 ? owned.map((k) => new PublicKey(k.toBase58())) : [...owned, extra];
          t.served.push(await c.getMultipleAccountsInfo(keys));
          t.served.push(await c.getMultipleAccountsInfo(keys.slice(0, 1)));
          t.served.push(await c.getMultipleAccountsInfo([]));
          t.served.push(c.other());
          return [];
        };
        vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ markets: rows }) }));
        await impl(conn, programId, "http://x");
        return t;
      };

      const a = await run(legacy);
      const b = await run(fresh);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        if (mismatches === 0) console.log("FIRSTMISMATCH", iter, mode, n, JSON.stringify(a).slice(0, 300), JSON.stringify(b).slice(0, 300), a.owned.length, b.owned.length, a.fall.length, b.fall.length);
        mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  }, 580_000);
});
