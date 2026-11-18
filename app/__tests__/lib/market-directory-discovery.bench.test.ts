/**
 * Perf measurement (not an assertion suite): times discoverMarketsViaProgramDirectory end to end
 * with a mocked fetch (500 directory rows) and a fake Connection, SDK parse stubbed out, and counts
 * PublicKey#toBase58 calls. Run: pnpm vitest run __tests__/lib/market-directory-discovery.bench.test.ts
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

const recorded: { conn: any; owned: PublicKey[] }[] = [];
vi.mock("@/lib/v22/discovery", () => ({
  getMarketsByAddress: vi.fn(async (conn: any, _p: PublicKey, owned: PublicKey[]) => {
    // what the SDK does: one getMultipleAccountsInfo over the owned addresses
    await conn.getMultipleAccountsInfo(owned);
    recorded.push({ conn, owned });
    return [];
  }),
}));

import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";

describe("bench: discoverMarketsViaProgramDirectory", () => {
  it("500 rows", async () => {
    const programId = Keypair.generate().publicKey;
    const keys = Array.from({ length: 500 }, () => Keypair.generate().publicKey.toBase58());
    const rows = [...keys, ...keys.slice(0, 50)].map((k) => ({ slab_address: k, program_id: programId.toBase58() }));
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ markets: rows }) }));
    const conn: any = {
      getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(() => ({ owner: programId, data: Buffer.alloc(0) })),
    };
    const orig = PublicKey.prototype.toBase58;
    let calls = 0;
    PublicKey.prototype.toBase58 = function (this: PublicKey) {
      calls++;
      return orig.call(this);
    };
    try {
      await discoverMarketsViaProgramDirectory(conn, programId, "http://x"); // warm
      calls = 0;
      const N = 10;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await discoverMarketsViaProgramDirectory(conn, programId, "http://x");
      const ms = (performance.now() - t0) / N;
      console.log(`BENCH ms/run=${ms.toFixed(2)} toBase58/run=${calls / N}`);
    } finally {
      PublicKey.prototype.toBase58 = orig;
    }
    expect(true).toBe(true);
  });
});
