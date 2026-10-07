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
  /**
   * The signed ADL-effective position (POS_SCALE q) this entry describes, measured on chain
   * right after the trade that saved it (#3314). Absent on records saved before it existed, or
   * when the measurement failed: such an entry is never carried into a later trade.
   */
  sizeQ?: string;
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

/**
 * Save entry price (mark at trade time) after a successful trade. `sizeQ` is the measured
 * signed effective position the entry describes (see EntryRecord.sizeQ).
 */
export function saveEntryPrice(
  slab: string,
  accountIdx: number,
  entryPriceE6: bigint,
  leverage?: number,
  wallet?: string,
  sizeQ?: bigint,
): void {
  try {
    const record: EntryRecord = {
      entryPriceE6: entryPriceE6.toString(),
      ...(leverage != null && Number.isFinite(leverage) && leverage > 0 ? { leverage } : {}),
      ...(sizeQ != null && sizeQ !== 0n ? { sizeQ: sizeQ.toString() } : {}),
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

/** The saved entry with the position it describes, or null when there is no usable record. */
export interface SavedEntry {
  entryPriceE6: bigint;
  leverage: number | null;
  /** Signed effective size the entry was saved for; null on a record without one. */
  sizeQ: bigint | null;
}

export function getSavedEntry(slab: string, accountIdx: number, wallet?: string): SavedEntry | null {
  try {
    const raw = localStorage.getItem(key(slab, accountIdx, wallet));
    if (!raw) return null;
    const record: EntryRecord = JSON.parse(raw);
    const entryPriceE6 = BigInt(record.entryPriceE6);
    if (entryPriceE6 <= 0n) return null;
    let sizeQ: bigint | null = null;
    try {
      sizeQ = record.sizeQ != null ? BigInt(record.sizeQ) : null;
    } catch {
      sizeQ = null;
    }
    const leverage =
      typeof record.leverage === "number" && Number.isFinite(record.leverage) && record.leverage > 0 ? record.leverage : null;
    return { entryPriceE6, leverage, sizeQ: sizeQ === 0n ? null : sizeQ };
  } catch {
    return null;
  }
}

const absQ = (q: bigint): bigint => (q < 0n ? -q : q);

/**
 * The entry to save after a trade on this position, from the position MEASURED on chain
 * before and after it (#3314). Both sizes are signed ADL-effective quantities: the engine
 * applies a trade to the effective position (`plan_delta`, lib/limits/effective-quantity.ts),
 * so raw basis would misread a sell on an ADL-reduced long as a reduce when it flipped.
 *
 *   - flat after                     → null (clear)
 *   - opened from flat, or flipped   → this fill's price, for the whole new position
 *   - reduced (same side, smaller)   → the saved entry, unchanged (average cost)
 *   - added (same side, larger)      → size-weighted average of the saved entry over the
 *                                      prior size and this fill over the added size
 *
 * Reduce and add need a saved entry that belongs to THIS position: its recorded size must be on
 * the same side and at least as large as the size before the trade (a partial close or partial
 * liquidation elsewhere only shrinks it; an add from another device grows it past the record,
 * and a record with no size is an older save nothing can vouch for). Otherwise → null, which is
 * what every trade on an open position did before: the surfaces fall back to an estimate.
 */
export function entryAfterTrade(a: {
  beforeQ: bigint;
  afterQ: bigint;
  saved: Pick<SavedEntry, "entryPriceE6" | "sizeQ"> | null;
  fillPriceE6: bigint;
}): bigint | null {
  const { beforeQ, afterQ, saved, fillPriceE6 } = a;
  if (afterQ === 0n) return null;
  const opened = beforeQ === 0n || (beforeQ > 0n) !== (afterQ > 0n);
  if (opened) return fillPriceE6 > 0n ? fillPriceE6 : null;
  if (!saved || saved.entryPriceE6 <= 0n || saved.sizeQ === null) return null;
  if ((saved.sizeQ > 0n) !== (beforeQ > 0n) || absQ(beforeQ) > absQ(saved.sizeQ)) return null;
  const before = absQ(beforeQ);
  const after = absQ(afterQ);
  if (after <= before) return saved.entryPriceE6;
  if (fillPriceE6 <= 0n) return null;
  return (before * saved.entryPriceE6 + (after - before) * fillPriceE6) / after;
}

/** Clear saved entry price (call when position is fully closed). */
export function clearEntryPrice(slab: string, accountIdx: number, wallet?: string): void {
  try {
    localStorage.removeItem(key(slab, accountIdx, wallet));
  } catch {
    // ignore
  }
}
