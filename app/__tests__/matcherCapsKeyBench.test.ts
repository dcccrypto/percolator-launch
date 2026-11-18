/**
 * Cache-hit micro-benchmark for matcherCaps key building (run: MATCHERCAPS_BENCH=/tmp/out.txt, the value is the file the result line is written to).
 * 100k hit calls over 20 slabs; prints ns/call. Skipped unless MATCHERCAPS_BENCH is set.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { Keypair } from "@solana/web3.js";

const resolveMarketLp = vi.fn();
vi.mock("@/lib/market-lp", () => ({ resolveMarketLp: (...a: unknown[]) => resolveMarketLp(...a) }));

import { getMatcherCaps, getMatcherInventory } from "@/lib/matcherCaps";

const N = 100_000;
const run = process.env.MATCHERCAPS_BENCH ? describe : describe.skip;

run("matcherCaps cache-hit bench", () => {
  it("ns/call", { timeout: 600_000 }, async () => {
    const program = Keypair.generate().publicKey;
    const slabs = Array.from({ length: 20 }, () => Keypair.generate().publicKey);
    const buf = Buffer.alloc(320);
    buf.writeBigUInt64LE(100n, 64 + 80);
    buf.writeBigUInt64LE(1000n, 64 + 128);
    const connection = { getAccountInfo: async () => ({ data: buf }) } as never;
    resolveMarketLp.mockImplementation(async () => ({
      matcherCtx: Keypair.generate().publicKey,
      pubkey: Keypair.generate().publicKey,
    }));
    for (const s of slabs) {
      await getMatcherCaps(connection, program, s);
      await getMatcherInventory(connection, program, s);
    }
    resolveMarketLp.mockClear();

    const t0 = performance.now();
    for (let i = 0; i < N; i++) await getMatcherCaps(connection, program, slabs[i % 20]);
    const capsNs = ((performance.now() - t0) * 1e6) / N;

    const t1 = performance.now();
    for (let i = 0; i < N; i++) await getMatcherInventory(connection, program, slabs[i % 20]);
    const ctxNs = ((performance.now() - t1) * 1e6) / N;

    fs.writeFileSync(process.env.MATCHERCAPS_BENCH!, `BENCH getMatcherCaps hit: ${capsNs.toFixed(0)} ns/call; ctx-address hit (getMatcherInventory): ${ctxNs.toFixed(0)} ns/call\n`);
    expect(resolveMarketLp).not.toHaveBeenCalled();
  });
});
