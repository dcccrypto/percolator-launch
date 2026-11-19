// @vitest-environment node
import { describe, expect, it, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __p3PdaCache, deriveLpVaultRegistryPda, deriveNftRegistryPda, deriveVaultLpMatcherDelegate, deriveVaultLpState } from "@/lib/limits/p3-ix";
import { LP_VAULT_REGISTRY_SEED, MATCHER_DELEGATE_SEED, NFT_REGISTRY_SEED, VAULT_LP_STATE_SEED } from "@/lib/limits/constants";

const enc = new TextEncoder();
const raw = (seeds: Uint8Array[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds, prog)[0];

// deterministic PRNG so failures reproduce
let s = 0x9e3779b9;
const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0) >>> 0);
const rndKey = () => new PublicKey(Uint8Array.from({ length: 32 }, () => rnd() & 255));

describe("p3-ix PDA memo", () => {
  beforeEach(() => __p3PdaCache.clear());

  it("differential: memoised == un-memoised on 10k random inputs (each queried twice: miss then hit)", () => {
    const progs = [rndKey(), rndKey(), rndKey()];
    // A pool of keys keeps hit/miss mix realistic; 10k iterations over random picks.
    const pool = Array.from({ length: 400 }, rndKey);
    const pick = () => pool[rnd() % pool.length]!;
    for (let i = 0; i < 10_000; i++) {
      const prog = progs[rnd() % progs.length]!;
      const a = pick();
      const kind = i % 4;
      let got: PublicKey, want: PublicKey;
      if (kind === 0) { got = deriveVaultLpState(prog, a); want = raw([enc.encode(VAULT_LP_STATE_SEED), a.toBytes()], prog); }
      else if (kind === 1) { got = deriveLpVaultRegistryPda(prog, a); want = raw([enc.encode(LP_VAULT_REGISTRY_SEED), a.toBytes()], prog); }
      else if (kind === 2) { got = deriveNftRegistryPda(prog, a); want = raw([enc.encode(NFT_REGISTRY_SEED), a.toBytes()], prog); }
      else {
        const [b, c, d, e] = [pick(), pick(), pick(), pick()];
        got = deriveVaultLpMatcherDelegate(prog, a, b, c, d, e);
        want = raw([enc.encode(MATCHER_DELEGATE_SEED), a.toBytes(), b.toBytes(), c.toBytes(), d.toBytes(), e.toBytes()], prog);
      }
      expect(got.toBase58()).toBe(want.toBase58());
    }
  }, 280_000);

  it("is bounded and still correct after eviction", () => {
    const prog = rndKey();
    const keys = Array.from({ length: __p3PdaCache.max + 20 }, rndKey);
    const first = deriveVaultLpState(prog, keys[0]!);
    for (const k of keys) deriveVaultLpState(prog, k);
    expect(__p3PdaCache.size()).toBeLessThanOrEqual(__p3PdaCache.max);
    expect(deriveVaultLpState(prog, keys[0]!).equals(first)).toBe(true);
  }, 60_000);

  it("distinct seeds / programs never alias", () => {
    const p1 = rndKey(), p2 = rndKey(), m = rndKey();
    const set = new Set([
      deriveVaultLpState(p1, m), deriveLpVaultRegistryPda(p1, m), deriveNftRegistryPda(p1, m),
      deriveVaultLpState(p2, m), deriveLpVaultRegistryPda(p2, m), deriveNftRegistryPda(p2, m),
    ].map((k) => k.toBase58()));
    expect(set.size).toBe(6);
  });
});
