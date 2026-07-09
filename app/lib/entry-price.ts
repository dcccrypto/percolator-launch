/**
 * Client-side entry price storage for V12_1 markets where on-chain entry_price
 * was removed. Stores mark price at trade time so the frontend can compute
 * unrealized PnL = (mark - entry) * position / mark.
 *
 * Storage key: `perc:entry:{slabAddress}:{accountIdx}` (legacy, wallet-less) or
 * `perc:entry:{slabAddress}:{accountIdx}:{wallet}` once a wallet pubkey is
 * supplied — see the BUG 10 comment on `key()` below.
 * Value: JSON `{ entryPriceE6: string, leverage?: number, timestamp: number }`
 */

const PREFIX = "perc:entry:";

interface EntryRecord {
  entryPriceE6: string;
  /** UI-selected order leverage at open time. Not an on-chain field. */
  leverage?: number;
  timestamp: number;
}

/**
 * BUG 10 fix: on v17 every standalone portfolio uses `accountIdx === 0` (one
 * account per wallet, not a bitmap slot — see useUserAccount's v17 path), so
 * the old `perc:entry:{slab}:{idx}` key collapsed to a SINGLE localStorage
 * slot per market shared by every wallet that ever traded it in this browser
 * — disconnecting Wallet A and connecting Wallet B showed Wallet A's cached
 * entry price for Wallet B's (possibly nonexistent) position.
 *
 * `wallet` (the connected wallet's base58 pubkey, or an account's on-chain
 * `owner`) scopes the key per-wallet. It's optional and appended LAST so
 * existing callers that don't pass one (e.g. `usePortfolio.ts`,
 * `useLiqPrice.ts`, `TradingChart.tsx`) keep resolving the legacy, unscoped
 * key and stay source-compatible — only trade-UI call sites that were
 * updated to pass a wallet get the fix.
 */
function key(slab: string, accountIdx: number, wallet?: string): string {
  return wallet ? `${PREFIX}${slab}:${accountIdx}:${wallet}` : `${PREFIX}${slab}:${accountIdx}`;
}

/** Save entry price (mark at trade time) after a successful trade open. */
export function saveEntryPrice(slab: string, accountIdx: number, entryPriceE6: bigint, leverage?: number, wallet?: string): void {
  try {
    const record: EntryRecord = {
      entryPriceE6: entryPriceE6.toString(),
      ...(leverage != null && Number.isFinite(leverage) && leverage > 0 ? { leverage } : {}),
      timestamp: Date.now(),
    };
    localStorage.setItem(key(slab, accountIdx, wallet), JSON.stringify(record));
  } catch {
    // localStorage may be unavailable (SSR, private browsing)
  }
}

/** Read saved entry price. Returns 0n if not found. */
export function getEntryPrice(slab: string, accountIdx: number, wallet?: string): bigint {
  try {
    const raw = localStorage.getItem(key(slab, accountIdx, wallet));
    if (!raw) return 0n;
    const record: EntryRecord = JSON.parse(raw);
    const value = BigInt(record.entryPriceE6);
    // Defense-in-depth: a corrupted or hand-edited localStorage entry could
    // carry a negative entryPriceE6 — on-chain entry price is always >= 0.
    // BigInt("-5") parses fine (no SyntaxError), so this needs an explicit
    // check. Treat it the same as "not found" rather than feeding a negative
    // entry into downstream PnL math ((mark - entry) * position / mark).
    return value < 0n ? 0n : value;
  } catch {
    return 0n;
  }
}

/** Read saved UI-selected order leverage. Returns null if not found. */
export function getEntryLeverage(slab: string, accountIdx: number, wallet?: string): number | null {
  try {
    const raw = localStorage.getItem(key(slab, accountIdx, wallet));
    if (!raw) return null;
    const record: EntryRecord = JSON.parse(raw);
    return typeof record.leverage === "number" && Number.isFinite(record.leverage) && record.leverage > 0
      ? record.leverage
      : null;
  } catch {
    return null;
  }
}

/** Clear saved entry price (call when position is fully closed). */
export function clearEntryPrice(slab: string, accountIdx: number, wallet?: string): void {
  try {
    localStorage.removeItem(key(slab, accountIdx, wallet));
  } catch {
    // ignore
  }
}
