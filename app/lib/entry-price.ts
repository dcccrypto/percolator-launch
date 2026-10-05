/**
 * Client-side entry price storage for V12_1 markets where on-chain entry_price
 * was removed. Stores mark price at trade time so the frontend can compute
 * unrealized PnL = (mark - entry) * position / mark.
 *
 * Storage key (segments appended left to right, each optional one only added
 * when supplied): `perc:entry:{slabAddress}:{accountIdx}[:{wallet}][:{portfolio}]`.
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
 * existing callers that don't pass one keep resolving the legacy, unscoped key.
 *
 * #2560 fix: `accountIdx` is ALSO always 0 on v17, so `{slab}:0:{wallet}` still
 * collapses every portfolio a wallet owns on a market to one slot — fine while
 * a wallet could only hold one portfolio per market, but isolated margin lets
 * it hold several, which would then corrupt each other's cached entry. The
 * optional `portfolio` (the portfolio account's base58 pubkey) scopes the key
 * per-portfolio. It too is appended LAST and is optional, so callers that don't
 * pass one are byte-identical to before; a portfolio-scoped READ that misses
 * falls back to the legacy (portfolio-less) key so entries saved before this
 * change still resolve (see `readRecord`). New trades always WRITE the scoped
 * key, so a freshly-opened portfolio never read-misses into another's legacy
 * entry.
 */
function key(slab: string, accountIdx: number, wallet?: string, portfolio?: string): string {
  let k = `${PREFIX}${slab}:${accountIdx}`;
  if (wallet) k += `:${wallet}`;
  // portfolio is only meaningful once a wallet scopes the key; guard so a bare
  // `(slab, idx, undefined, portfolio)` can't produce an ambiguous segment.
  if (wallet && portfolio) k += `:${portfolio}`;
  return k;
}

/** Parse one stored record, or null (missing / corrupt / SSR / private mode). */
function readRecord(storageKey: string): EntryRecord | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as EntryRecord;
  } catch {
    return null;
  }
}

/**
 * Resolve a record for (slab, idx, wallet, portfolio): the portfolio-scoped key
 * first, then — only when a portfolio was requested — the legacy portfolio-less
 * key, so entries written before #2560 still resolve for that wallet's primary
 * portfolio. A portfolio opened after #2560 always has its own scoped record
 * (written at open), so it never falls through to another portfolio's legacy
 * entry.
 */
function resolveRecord(slab: string, accountIdx: number, wallet?: string, portfolio?: string): EntryRecord | null {
  const scoped = readRecord(key(slab, accountIdx, wallet, portfolio));
  if (scoped) return scoped;
  if (wallet && portfolio) return readRecord(key(slab, accountIdx, wallet));
  return null;
}

/** Save entry price (mark at trade time) after a successful trade open. */
export function saveEntryPrice(
  slab: string,
  accountIdx: number,
  entryPriceE6: bigint,
  leverage?: number,
  wallet?: string,
  portfolio?: string,
): void {
  try {
    const record: EntryRecord = {
      entryPriceE6: entryPriceE6.toString(),
      ...(leverage != null && Number.isFinite(leverage) && leverage > 0 ? { leverage } : {}),
      timestamp: Date.now(),
    };
    localStorage.setItem(key(slab, accountIdx, wallet, portfolio), JSON.stringify(record));
  } catch {
    // localStorage may be unavailable (SSR, private browsing)
  }
}

/** Read saved entry price. Returns 0n if not found. */
export function getEntryPrice(slab: string, accountIdx: number, wallet?: string, portfolio?: string): bigint {
  try {
    const record = resolveRecord(slab, accountIdx, wallet, portfolio);
    if (!record) return 0n;
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
export function getEntryLeverage(slab: string, accountIdx: number, wallet?: string, portfolio?: string): number | null {
  const record = resolveRecord(slab, accountIdx, wallet, portfolio);
  if (!record) return null;
  return typeof record.leverage === "number" && Number.isFinite(record.leverage) && record.leverage > 0
    ? record.leverage
    : null;
}

/** Clear saved entry price (call when position is fully closed). Removes the
 *  portfolio-scoped key and, when a portfolio was given, the legacy
 *  portfolio-less key too, so a migrated primary-portfolio entry can't linger
 *  as a stale fallback after its position is gone. */
export function clearEntryPrice(slab: string, accountIdx: number, wallet?: string, portfolio?: string): void {
  try {
    localStorage.removeItem(key(slab, accountIdx, wallet, portfolio));
    if (wallet && portfolio) localStorage.removeItem(key(slab, accountIdx, wallet));
  } catch {
    // ignore
  }
}
