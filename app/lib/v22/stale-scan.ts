/**
 * Review F14: the inline-refresh stale set is found with ONE `getProgramAccounts` scan (10.6 KB accounts) per exit.
 * Every later read in the same exit (the 118 retries, the send after the quote) re-reads only the accounts that were
 * stale in that scan (`getMultipleAccountsInfo`), which is both cheap and what a retry needs: "which of those are
 * still stale". A portfolio that becomes stale after the scan is deferred, never refreshed blind.
 */
import type { PublicKey } from "@solana/web3.js";

export interface StaleRow {
  pubkey: PublicKey;
  data: Uint8Array;
}

export interface StaleReader<C> {
  /** Candidates still stale now. The first call (or after `reset`) scans; later calls re-read the scanned keys. */
  read(): Promise<C[]>;
  reset(): void;
}

export function makeStaleReader<C extends { key: PublicKey }>(deps: {
  scan: () => Promise<StaleRow[]>;
  fetchMany: (keys: PublicKey[]) => Promise<StaleRow[]>;
  toCandidates: (rows: StaleRow[]) => C[];
}): StaleReader<C> {
  let keys: PublicKey[] | null = null;
  return {
    async read() {
      if (keys === null) {
        const rows = await deps.scan();
        const cands = deps.toCandidates(rows);
        keys = cands.map((c) => c.key);
        return cands;
      }
      if (keys.length === 0) return [];
      return deps.toCandidates(await deps.fetchMany(keys));
    },
    reset() {
      keys = null;
    },
  };
}
