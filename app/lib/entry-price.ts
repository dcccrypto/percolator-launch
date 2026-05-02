/**
 * Client-side entry price storage for V12_1 markets where on-chain entry_price
 * was removed. Stores mark price at trade time so the frontend can compute
 * unrealized PnL = (mark - entry) * position / mark.
 *
 * Storage key: `perc:entry:{slabAddress}:{accountIdx}`
 * Value: JSON `{ entryPriceE6: string, leverage?: number, timestamp: number }`
 */

const PREFIX = "perc:entry:";

interface EntryRecord {
  entryPriceE6: string;
  /** UI-selected order leverage at open time. Not an on-chain field. */
  leverage?: number;
  timestamp: number;
}

function key(slab: string, accountIdx: number): string {
  return `${PREFIX}${slab}:${accountIdx}`;
}

/** Save entry price (mark at trade time) after a successful trade open. */
export function saveEntryPrice(slab: string, accountIdx: number, entryPriceE6: bigint, leverage?: number): void {
  try {
    const record: EntryRecord = {
      entryPriceE6: entryPriceE6.toString(),
      ...(leverage != null && Number.isFinite(leverage) && leverage > 0 ? { leverage } : {}),
      timestamp: Date.now(),
    };
    localStorage.setItem(key(slab, accountIdx), JSON.stringify(record));
  } catch {
    // localStorage may be unavailable (SSR, private browsing)
  }
}

/** Read saved entry price. Returns 0n if not found. */
export function getEntryPrice(slab: string, accountIdx: number): bigint {
  try {
    const raw = localStorage.getItem(key(slab, accountIdx));
    if (!raw) return 0n;
    const record: EntryRecord = JSON.parse(raw);
    return BigInt(record.entryPriceE6);
  } catch {
    return 0n;
  }
}

/** Read saved UI-selected order leverage. Returns null if not found. */
export function getEntryLeverage(slab: string, accountIdx: number): number | null {
  try {
    const raw = localStorage.getItem(key(slab, accountIdx));
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
export function clearEntryPrice(slab: string, accountIdx: number): void {
  try {
    localStorage.removeItem(key(slab, accountIdx));
  } catch {
    // ignore
  }
}
