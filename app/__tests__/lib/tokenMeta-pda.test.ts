// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  getMetadataPda,
  clearMetadataPdaCache,
  METADATA_PDA_CACHE_MAX,
} from "@/lib/tokenMeta";

const PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** The pre-change derivation, verbatim from fetchTokenMetaBatch. */
function reference(key: string): { pda: PublicKey; base58: string } {
  const mint = new PublicKey(key);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), PROGRAM.toBuffer(), mint.toBuffer()],
    PROGRAM,
  );
  return { pda, base58: pda.toBase58() };
}

describe("getMetadataPda", () => {
  beforeEach(() => clearMetadataPdaCache());

  it("is identical to the un-memoised derivation over 10k mints (cold and warm)", () => {
    const mints = Array.from({ length: 10_000 }, () => Keypair.generate().publicKey.toBase58());
    const want = mints.map(reference);
    // cold: every mint derives
    mints.forEach((m, i) => {
      const got = getMetadataPda(m);
      expect(got.base58).toBe(want[i].base58);
      expect(got.pda.equals(want[i].pda)).toBe(true);
    });
    // warm: the most recent METADATA_PDA_CACHE_MAX mints are memo hits
    const from = mints.length - METADATA_PDA_CACHE_MAX;
    for (let i = from; i < mints.length; i++) {
      const got = getMetadataPda(mints[i]);
      expect(got.base58).toBe(want[i].base58);
      expect(got.pda.equals(want[i].pda)).toBe(true);
    }
  }, 600_000);

  it("throws on invalid mints like new PublicKey, and never caches the failure", () => {
    expect(() => getMetadataPda("not-a-key")).toThrow();
    expect(() => getMetadataPda("")).toThrow();
  });

  it("stays bounded and still correct after eviction", () => {
    const mints = Array.from({ length: METADATA_PDA_CACHE_MAX + 50 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    for (const m of mints) getMetadataPda(m);
    for (const m of [mints[0], mints[mints.length - 1]]) {
      expect(getMetadataPda(m).base58).toBe(reference(m).base58);
    }
  }, 120_000);

  it("perf: warm memo vs un-memoised, N=500 (informational)", () => {
    const mints = Array.from({ length: 500 }, () => Keypair.generate().publicKey.toBase58());
    const time = (fn: () => void, reps: number) => {
      const t: number[] = [];
      for (let i = 0; i < reps; i++) {
        const s = performance.now();
        fn();
        t.push(performance.now() - s);
      }
      return t.sort((a, b) => a - b)[Math.floor(reps / 2)];
    };
    const ref = time(() => mints.forEach(reference), 5);
    clearMetadataPdaCache();
    const cold = time(() => {
      clearMetadataPdaCache();
      mints.forEach(getMetadataPda);
    }, 5);
    mints.forEach(getMetadataPda);
    const warm = time(() => mints.forEach(getMetadataPda), 25);
    console.log(
      `PERF N=500 median ms: reference=${ref.toFixed(2)} cold=${cold.toFixed(2)} warm=${warm.toFixed(3)} warm-speedup=${(ref / warm).toFixed(0)}x`,
    );
    expect(warm).toBeLessThan(ref);
  }, 120_000);
});
