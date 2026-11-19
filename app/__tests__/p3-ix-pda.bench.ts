import { bench, describe } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpVaultRegistryPda, deriveNftRegistryPda, deriveVaultLpMatcherDelegate, deriveVaultLpState } from "@/lib/limits/p3-ix";

// N=1000 derivations over a small market set (what polls / renders see: the same few markets, repeatedly).
// Fixed iteration count so a ~100ms body still yields samples.
const N = 1000;
const OPTS = { time: 0, iterations: 5, warmupTime: 0, warmupIterations: 1 };
const PROG = Keypair.generate().publicKey;
const MP = Keypair.generate().publicKey;
const MARKETS: PublicKey[] = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
const LP = Keypair.generate().publicKey;
const CTX = Keypair.generate().publicKey;

describe("p3-ix PDA derivation, N=1000 over 6 markets", () => {
  bench("deriveVaultLpState", () => {
    for (let i = 0; i < N; i++) deriveVaultLpState(PROG, MARKETS[i % MARKETS.length]!);
  }, OPTS);
  bench("deriveLpVaultRegistryPda", () => {
    for (let i = 0; i < N; i++) deriveLpVaultRegistryPda(PROG, MARKETS[i % MARKETS.length]!);
  }, OPTS);
  bench("deriveNftRegistryPda", () => {
    for (let i = 0; i < N; i++) deriveNftRegistryPda(PROG, MARKETS[i % MARKETS.length]!);
  }, OPTS);
  bench("deriveVaultLpMatcherDelegate", () => {
    for (let i = 0; i < N; i++) {
      const m = MARKETS[i % MARKETS.length]!;
      deriveVaultLpMatcherDelegate(PROG, m, LP, m, MP, CTX);
    }
  }, OPTS);
});
