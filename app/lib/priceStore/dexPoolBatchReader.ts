/**
 * dexPoolBatchReader.ts — batched mainnet DEX price reads for scripts/local-price-ws-server.ts.
 *
 * The per-market reader (readPoolPriceE6) costs 1 getAccountInfo for the pool plus 2 for the
 * PumpSwap vaults, per market, per cycle. At ~80 markets and a 500 ms cadence that is ~150 calls/s.
 * Almost none of it changes:
 *
 *   static  (resolved once, refreshed every STATIC_TTL_MS): pool owner/dex type, pool layout, quote
 *           mint, PumpSwap base/quote vault addresses, mint decimals (cached in decimalsCache);
 *   changing (read EVERY cycle):  PumpSwap -> the 2 vault token accounts;
 *                                 Raydium CLMM / Meteora DLMM -> the pool account itself (the price
 *                                 state, sqrtPrice / active bin, lives in it).
 *
 * Each cycle reads every changing account of every market with getMultipleAccountsInfo in chunks of
 * 100 (one RPC credit per chunk). The price math is NOT re-implemented: the prefetched accounts are
 * fed to the same `priceFromAccounts` that readPoolPriceE6 uses, so results are byte-identical.
 * Per-market isolation is kept: a missing/invalid account skips (or errors) that market only, and a
 * failed chunk fails only the markets whose accounts were in it.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { parseDexPool } from "@percolatorct/sdk";
import {
  priceFromAccounts,
  quoteIsNotUsdOrWsol,
  withRpcBackoff,
  type AccountData,
  type DecimalsCache,
  type PoolReadEntry,
  type PriceReadResult,
} from "./dexPoolReader";

/** getMultipleAccountsInfo's per-call account limit. */
export const MAX_ACCOUNTS_PER_CALL = 100;
/** How long a pool's static facts (owner, vault addresses) are trusted before being re-read. */
export const STATIC_TTL_MS = 60_000;
/** A pool that could not be resolved (not found yet / RPC failure) is retried sooner. */
export const RETRY_UNRESOLVED_MS = 10_000;

/** Outcome for one pool: a price/skip result, or an error (RPC failure, malformed account). */
export type PoolOutcome = { kind: "result"; result: PriceReadResult } | { kind: "error"; error: string };

interface Plan {
  entry: PoolReadEntry;
  poolPk: PublicKey;
  /** Pool account as read at resolve time (null = not found). Served from here when static. */
  poolInfo: AccountData | null;
  /** Pool account is re-read every cycle (CLMM/DLMM) instead of served from `poolInfo`. */
  poolIsChanging: boolean;
  /** Account keys (base58) read every cycle for this pool. */
  changing: string[];
  resolvedAt: number;
  /** True when resolve failed or found nothing: retried after RETRY_UNRESOLVED_MS. */
  unresolved: boolean;
  resolveError?: string;
}

export interface BatchPoolReaderOptions {
  now?: () => number;
  staticTtlMs?: number;
}

export interface BatchPoolReader {
  /**
   * Price every pool in `entries` (deduplicated by pool address). Pools not seen before are
   * resolved first (so a market added to the list mid-run is picked up on its first cycle); pools
   * no longer in `entries` are forgotten.
   */
  readAll(entries: readonly PoolReadEntry[], solPriceE6?: bigint): Promise<Map<string, PoolOutcome>>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** getMultipleAccountsInfo over `keys` in chunks of 100, chunks in parallel. Keys of a failed chunk map to the error. */
async function fetchAccounts(
  conn: Connection,
  keys: readonly string[],
): Promise<{ accounts: Map<string, AccountData | null>; failed: Map<string, string> }> {
  const accounts = new Map<string, AccountData | null>();
  const failed = new Map<string, string>();
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_CALL) chunks.push(keys.slice(i, i + MAX_ACCOUNTS_PER_CALL));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const infos = await withRpcBackoff(() =>
          conn.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k)), "confirmed"),
        );
        chunk.forEach((k, i) => accounts.set(k, infos[i] ?? null));
      } catch (err) {
        for (const k of chunk) failed.set(k, errMsg(err));
      }
    }),
  );
  return { accounts, failed };
}

export function createBatchPoolReader(
  conn: Connection,
  decimalsCache: DecimalsCache,
  opts: BatchPoolReaderOptions = {},
): BatchPoolReader {
  const now = opts.now ?? Date.now;
  const staticTtlMs = opts.staticTtlMs ?? STATIC_TTL_MS;
  const plans = new Map<string, Plan>();

  function buildPlan(entry: PoolReadEntry, info: AccountData | null, at: number, resolveError?: string): Plan {
    const poolPk = new PublicKey(entry.poolAddress);
    const base = { entry, poolPk, poolInfo: info, resolvedAt: at, resolveError };
    if (!info || info.data.length === 0) {
      return { ...base, poolIsChanging: false, changing: [], unresolved: true };
    }
    if (entry.dexType === "pumpswap") {
      // Pool data is immutable (mints + vault addresses); only the vault balances move. Anything the
      // price code rejects before touching the vaults (wrong owner, non-USD quote, short data) needs
      // no vault reads, and priceFromAccounts reports the reason from the cached pool bytes.
      try {
        const parsed = parseDexPool("pumpswap", poolPk, new Uint8Array(info.data));
        if (!quoteIsNotUsdOrWsol(parsed.quoteMint) && parsed.baseVault && parsed.quoteVault) {
          return {
            ...base,
            poolIsChanging: false,
            changing: [parsed.baseVault.toBase58(), parsed.quoteVault.toBase58()],
            unresolved: false,
          };
        }
      } catch {
        /* malformed pool: priceFromAccounts reports it per cycle */
      }
      return { ...base, poolIsChanging: false, changing: [], unresolved: false };
    }
    // raydium-clmm / meteora-dlmm: the price state is in the pool account itself.
    return { ...base, poolIsChanging: true, changing: [entry.poolAddress], unresolved: false };
  }

  /** (Re)resolve the static facts of `entries` with one batched read of their pool accounts. */
  async function resolve(entries: readonly PoolReadEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const at = now();
    const { accounts, failed } = await fetchAccounts(conn, entries.map((e) => e.poolAddress));
    for (const entry of entries) {
      const err = failed.get(entry.poolAddress);
      const prev = plans.get(entry.poolAddress);
      if (err !== undefined) {
        // Keep serving the previous plan if there is one; just retry soon.
        if (prev) plans.set(entry.poolAddress, { ...prev, entry, resolvedAt: at - staticTtlMs + RETRY_UNRESOLVED_MS });
        else plans.set(entry.poolAddress, { ...buildPlan(entry, null, at, err), unresolved: true });
        continue;
      }
      plans.set(entry.poolAddress, buildPlan(entry, accounts.get(entry.poolAddress) ?? null, at));
    }
  }

  return {
    async readAll(entries, solPriceE6) {
      const unique = new Map<string, PoolReadEntry>();
      for (const e of entries) if (!unique.has(e.poolAddress)) unique.set(e.poolAddress, e);
      for (const k of plans.keys()) if (!unique.has(k)) plans.delete(k);

      const t = now();
      const stale: PoolReadEntry[] = [];
      for (const e of unique.values()) {
        const p = plans.get(e.poolAddress);
        const ttl = p?.unresolved ? RETRY_UNRESOLVED_MS : staticTtlMs;
        if (!p || p.entry.dexType !== e.dexType || t - p.resolvedAt >= ttl) stale.push(e);
      }
      try {
        await resolve(stale);
      } catch (err) {
        // resolve() isolates chunk failures itself; anything else must not kill the cycle.
        console.warn("[dexPoolBatchReader] static resolve failed:", errMsg(err));
      }

      // One batched read of every changing account of every market.
      const keySet = new Set<string>();
      for (const e of unique.values()) for (const k of plans.get(e.poolAddress)?.changing ?? []) keySet.add(k);
      const { accounts, failed } = await fetchAccounts(conn, [...keySet]);

      const out = new Map<string, PoolOutcome>();
      await Promise.all(
        [...unique.values()].map(async (e) => {
          const plan = plans.get(e.poolAddress);
          if (!plan) {
            out.set(e.poolAddress, { kind: "error", error: "pool plan missing" });
            return;
          }
          const reader = async (pk: PublicKey): Promise<AccountData | null> => {
            const key = pk.toBase58();
            if (key === e.poolAddress && !plan.poolIsChanging) return plan.poolInfo;
            const fe = failed.get(key);
            if (fe !== undefined) throw new Error(fe);
            if (accounts.has(key)) return accounts.get(key) ?? null;
            // Not prefetched (should not happen): fall back to a single read rather than guess.
            return withRpcBackoff(() => conn.getAccountInfo(pk, "confirmed"));
          };
          try {
            const result = await priceFromAccounts(conn, plan.entry, decimalsCache, solPriceE6, reader);
            out.set(e.poolAddress, { kind: "result", result });
          } catch (err) {
            out.set(e.poolAddress, { kind: "error", error: errMsg(err) });
          }
        }),
      );
      return out;
    },
  };
}
