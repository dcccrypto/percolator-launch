/**
 * Review F14: the inline-refresh stale set is found with ONE `getProgramAccounts` scan (10.6 KB accounts) per exit.
 * Every later read in the same exit (the 118 retries, the send after the quote) re-reads only the accounts that were
 * stale in that scan (`getMultipleAccountsInfo`), which is both cheap and what a retry needs: "which of those are
 * still stale". N3: a portfolio that becomes stale AFTER the scan is picked up by `rescan()`, which the 118 retry
 * calls once per round (scans = 1 + number of 118 rounds), so the retry loop can actually fix such a 118.
 */
import type { PublicKey } from "@solana/web3.js";

export interface StaleRow {
  pubkey: PublicKey;
  data: Uint8Array;
}

export interface StaleReader<C> {
  /** Candidates still stale now. The first call (or after `reset`) scans; later calls re-read the scanned keys. */
  read(): Promise<C[]>;
  /** One fresh scan (replaces the remembered keys). Used once per 118 retry round. */
  rescan(): Promise<C[]>;
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
    async rescan() {
      const cands = deps.toCandidates(await deps.scan());
      keys = cands.map((c) => c.key);
      return cands;
    },
    reset() {
      keys = null;
    },
  };
}
