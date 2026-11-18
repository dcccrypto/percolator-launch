/**
 * Bounded memo for pure PDA derivations on the Earn poll path.
 *
 * `PublicKey.findProgramAddressSync` is a pure function of (program, market, domain) but costs up to 255
 * hash + curve checks per call; the 15 s Earn poll re-derived ~105 registry PDAs and 2 ledger PDAs per
 * vault every cycle. The result never changes, so cache it. FIFO-bounded so a long-lived tab that sees
 * many markets cannot grow it without limit. Cached PublicKeys are shared: callers must not mutate them
 * (web3.js PublicKey is treated as immutable everywhere in the app).
 */
import { PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveLpVaultRegistry } from "@percolatorct/sdk";

export const PDA_MEMO_MAX = 1024;

class FifoMemo<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string, make: () => V): V {
    const hit = this.m.get(key);
    if (hit !== undefined) return hit;
    const v = make();
    if (this.m.size >= this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(key, v);
    return v;
  }
  get size(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
}

const keys = new FifoMemo<PublicKey>(PDA_MEMO_MAX);
const registries = new FifoMemo<PublicKey>(PDA_MEMO_MAX);
const ledgers = new FifoMemo<PublicKey>(PDA_MEMO_MAX * 2);

/** `new PublicKey(base58)`, parsed once. Throws (uncached) on an invalid string, like the constructor. */
export function cachedPublicKey(base58: string): PublicKey {
  return keys.get(base58, () => new PublicKey(base58));
}

/** deriveLpVaultRegistry(programId, market)[0], memoised. */
export function cachedLpVaultRegistryPda(programId: PublicKey, market: PublicKey): PublicKey {
  const k = `${programId.toBase58()}:${market.toBase58()}`;
  return registries.get(k, () => deriveLpVaultRegistry(programId, market)[0]);
}

/** deriveLpBackingLedger(programId, market, domain)[0], memoised. */
export function cachedLpBackingLedgerPda(programId: PublicKey, market: PublicKey, domain: number): PublicKey {
  const k = `${programId.toBase58()}:${market.toBase58()}:${domain}`;
  return ledgers.get(k, () => deriveLpBackingLedger(programId, market, domain)[0]);
}

/** Test hook. */
export function _clearPdaMemo(): void {
  keys.clear();
  registries.clear();
  ledgers.clear();
}
export function _pdaMemoSizes(): { keys: number; registries: number; ledgers: number } {
  return { keys: keys.size, registries: registries.size, ledgers: ledgers.size };
}
