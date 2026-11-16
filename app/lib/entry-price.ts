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
  /**
   * The BOOKED price (the engine's basis: the mark at execution) when `entryPriceE6` is the price the trader EFFECTIVELY paid (booked +/- the
   * spread part of the fee, lib/v22/exec-fill.ts effectivePriceE6). Risk math (liquidation price, equity) uses this one: the spread already
   * left capital as a fee, so valuing the position from the fill price there would count it a second time. Absent = the entry IS the basis.
   */
  bookedPriceE6?: string;
  /**
   * r9 Risk MED: the growth BUSY-SIDE (utilisation) fee paid when this position was opened, in collateral atoms, TOTAL for the position
   * `sizeQ` describes ("0" = measured: none was paid). It is not part of the Entry (#3810), so the close dialog's net result would miss it.
   * Blends on an add (prior share + this fill's) and scales with size on a reduce (busyFeeAfterTrade). Absent = unknown (an older record, a
   * fill whose fee could not be split, or a trade whose prior amount was unknown): never read as zero on a market that can charge one.
   */
  busyFeeAtoms?: string;
  /**
   * The save made the moment a fill landed, BEFORE the position's size is measured on chain (so it has no `sizeQ`). It is the opening
   * device's own entry for a short window (PENDING_ENTRY_WINDOW_MS); the measured save replaces it (or the window ends and it stops counting).
   */
  pending?: boolean;
  /**
   * r10: set only on a record rebuilt from the chain (lib/entry-chain-sync.ts): the portfolio's newest transaction signature when it was read. A
   * newer signature makes the record unverified (a same-size close + reopen elsewhere), so it is re-checked, never trusted by size alone.
   */
  chainSig?: string;
  /**
   * Council r10 round 2 MED: the signature of the newest change (fill) this record includes. The chain check (lib/entry-chain-sync.ts) keeps a
   * record this device wrote only while that is still the position's newest change on chain; a same-size close + reopen elsewhere is not.
   */
  lastSig?: string;
  timestamp: number;
}

/** How long a size-less `pending` save counts as this position's entry: long enough for the post-trade measurement (takePositionChange waits up to 8 s), short enough that a change from another device is not masked. */
export const PENDING_ENTRY_WINDOW_MS = 60_000;

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
  opts?: { bookedPriceE6?: bigint; pending?: boolean; busyFeeAtoms?: bigint | null; chainSig?: string; lastSig?: string | null },
): void {
  try {
    const record: EntryRecord = {
      entryPriceE6: entryPriceE6.toString(),
      ...(opts?.bookedPriceE6 != null && opts.bookedPriceE6 > 0n && opts.bookedPriceE6 !== entryPriceE6 ? { bookedPriceE6: opts.bookedPriceE6.toString() } : {}),
      ...(opts?.busyFeeAtoms != null && opts.busyFeeAtoms >= 0n ? { busyFeeAtoms: opts.busyFeeAtoms.toString() } : {}),
      ...(opts?.chainSig ? { chainSig: opts.chainSig } : {}),
      ...(opts?.lastSig ? { lastSig: opts.lastSig } : {}),
      ...(opts?.pending && (sizeQ == null || sizeQ === 0n) ? { pending: true } : {}),
      ...(leverage != null && Number.isFinite(leverage) && leverage > 0 ? { leverage } : {}),
      ...(sizeQ != null && sizeQ !== 0n ? { sizeQ: sizeQ.toString() } : {}),
      timestamp: Date.now(),
    };
    localStorage.setItem(key(slab, accountIdx, wallet), JSON.stringify(record));
    // A real save (this device's own measured fill, a fresh open, a chain rebuild) replaces an "unknown" marker.
    localStorage.removeItem(unknownKey(slab, accountIdx, wallet));
  } catch {
    // localStorage may be unavailable (SSR, private browsing)
  }
}

/**
 * r10 owner decision 2 (r9 "unknown"): the explicit "this position's Entry is UNKNOWN" marker. The ticket writes it when the fill could not be
 * priced honestly (the busy rate charged differs from the quoted one, or a raised-fee Custom order), so no later source may fill a number in:
 * the chain rebuild (lib/entry-chain-sync.ts) never runs for a marked position and never overwrites it. It outlives the `clearEntryPrice` calls
 * of later trades on the position; a real measured save, or a fresh open from flat on this device, replaces it.
 */
const UNKNOWN_PREFIX = "perc:entry-unknown:";
const unknownKey = (slab: string, accountIdx: number, wallet?: string): string => `${UNKNOWN_PREFIX}${slab}:${accountIdx}${wallet ? `:${wallet}` : ""}`;
/**
 * The marker is tied to the size the unpriced open / add left the position at (`sizeQ`, signed effective): it is honoured only while the chain
 * holds that size, so a later trade (a different size) retires it, and a close to flat clears it (`clearEntryPrice(..., { flat: true })`).
 */
/** Did a trade from `beforeQ` to `afterQ` open or add to a position (or flip it)? Only such a fill leaves the Entry unknown when it cannot be priced; a reduce keeps the average it had. */
export function tradeGrewPosition(beforeQ: bigint, afterQ: bigint): boolean {
  if (afterQ === 0n) return false;
  return beforeQ === 0n || (beforeQ > 0n) !== (afterQ > 0n) || absQ(afterQ) > absQ(beforeQ);
}

/**
 * The marker's content: the size the unpriced fill left the position at and the signature of that fill. The signature lets the chain rebuild
 * retire the marker when the position it was about is gone (closed and reopened elsewhere, even at the same size).
 */
export interface UnknownMark {
  sizeQ: bigint;
  sig: string | null;
}

export function markEntryUnknown(slab: string, accountIdx: number, wallet: string | undefined, sizeQ: bigint, sig?: string | null): void {
  try {
    localStorage.setItem(unknownKey(slab, accountIdx, wallet), JSON.stringify({ sizeQ: sizeQ.toString(), ...(sig ? { sig } : {}), ts: Date.now() }));
  } catch {
    // ignore
  }
}

/**
 * Marks the position unknown after a fill that was READ but could not be priced, only when the fill opened or added (a reduce keeps the average
 * it had). Returns whether a marker was written. Called BEFORE the entry is cleared with the size the order should leave (so another tab never
 * sees a cleared entry without a marker), and again with the measured size.
 */
export function markUnpricedFill(slab: string, accountIdx: number, wallet: string | undefined, sig: string | null, beforeQ: bigint, afterQ: bigint): boolean {
  if (!tradeGrewPosition(beforeQ, afterQ)) return false;
  markEntryUnknown(slab, accountIdx, wallet, afterQ, sig);
  return true;
}

/** The marker standing for `currentQ`, or null; a marker for another size is stale and is removed. */
export function getEntryUnknownMark(slab: string, accountIdx: number, wallet: string | undefined, currentQ: bigint): UnknownMark | null {
  try {
    const raw = localStorage.getItem(unknownKey(slab, accountIdx, wallet));
    if (raw === null) return null;
    let size: string | null = null;
    let sig: string | null = null;
    try {
      const j = JSON.parse(raw) as { sizeQ?: unknown; sig?: unknown };
      size = typeof j.sizeQ === "string" ? j.sizeQ : null;
      sig = typeof j.sig === "string" ? j.sig : null;
    } catch {
      size = null;
    }
    if (size !== null && size === currentQ.toString()) return { sizeQ: currentQ, sig };
    localStorage.removeItem(unknownKey(slab, accountIdx, wallet));
    return null;
  } catch {
    return null;
  }
}
/** True while the marker stands for `currentQ`. */
export function isEntryMarkedUnknown(slab: string, accountIdx: number, wallet: string | undefined, currentQ: bigint): boolean {
  return getEntryUnknownMark(slab, accountIdx, wallet, currentQ) !== null;
}
export function clearEntryUnknownMark(slab: string, accountIdx: number, wallet?: string): void {
  try {
    localStorage.removeItem(unknownKey(slab, accountIdx, wallet));
  } catch {
    // ignore
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
  /** The engine's basis price for the same position (== entryPriceE6 when the record has none). */
  bookedPriceE6: bigint;
  /** The busy-side fee paid at open for the WHOLE position `sizeQ` (atoms); null = unknown (see EntryRecord.busyFeeAtoms). */
  busyFeeAtoms: bigint | null;
  /** r10: the portfolio signature a chain-rebuilt record was read at (null = a record this device wrote itself). */
  chainSig: string | null;
  /** The newest change this record includes (see EntryRecord.lastSig); null = not recorded (an older save). */
  lastSig: string | null;
  /** When the record was saved (ms). */
  savedAt: number;
  /** A fresh size-less save from the fill that has not been measured yet (see EntryRecord.pending). Always false once the window has passed. */
  pending: boolean;
}

/** The two facts that decide whether a saved entry still describes the position. */
export type EntryCheck = Pick<SavedEntry, "sizeQ" | "pending">;

/**
 * Whether a saved entry still describes the position measured on chain NOW (r8): only while that position's signed ADL-effective size
 * equals the size the entry was saved for. A trade from another device (an add, a reduce, a flip, a close) changes the size, so a record
 * this device wrote earlier no longer says what the entry is; a record with no size cannot vouch for anything. The one exception is the
 * opening device's own fresh `pending` save (no size yet, within PENDING_ENTRY_WINDOW_MS): it has nothing to compare against until the
 * measurement lands and replaces it, and must not flicker to "unknown" meanwhile. An unknown effective size (ADL factors unreadable)
 * cannot be compared, so only the pending save stands.
 */
export function entryRecordCurrent(check: EntryCheck, effectiveSizeQ: bigint | null): boolean {
  if (check.sizeQ !== null) return effectiveSizeQ !== null && check.sizeQ === effectiveSizeQ;
  return check.pending;
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
    let bookedPriceE6 = entryPriceE6;
    try {
      const b = record.bookedPriceE6 != null ? BigInt(record.bookedPriceE6) : 0n;
      if (b > 0n) bookedPriceE6 = b;
    } catch {
      bookedPriceE6 = entryPriceE6;
    }
    let busyFeeAtoms: bigint | null = null;
    try {
      const b = record.busyFeeAtoms != null ? BigInt(record.busyFeeAtoms) : null;
      busyFeeAtoms = b !== null && b >= 0n ? b : null;
    } catch {
      busyFeeAtoms = null;
    }
    const sized = sizeQ !== null && sizeQ !== 0n;
    const fresh = typeof record.timestamp === "number" && Date.now() - record.timestamp >= 0 && Date.now() - record.timestamp < PENDING_ENTRY_WINDOW_MS;
    return { entryPriceE6, leverage, sizeQ: sized ? sizeQ : null, bookedPriceE6, busyFeeAtoms, chainSig: typeof record.chainSig === "string" ? record.chainSig : null, lastSig: typeof record.lastSig === "string" && record.lastSig ? record.lastSig : null, savedAt: typeof record.timestamp === "number" ? record.timestamp : 0, pending: !sized && record.pending === true && fresh };
  } catch {
    return null;
  }
}

/**
 * The device-cached entry for the position measured NOW, or zeros when there is none or it no longer describes that position
 * (`entryRecordCurrent`). `entryE6` is the price paid (display), `riskEntryE6` the engine's basis (risk math). The reader for any
 * consumer that has an effective size and does not go through `computePositionPnl`.
 */
export function getCurrentEntry(
  slab: string,
  accountIdx: number,
  wallet: string | undefined,
  effectiveSizeQ: bigint | null,
): { entryE6: bigint; riskEntryE6: bigint; busyFeeAtoms: bigint | null } {
  const saved = getSavedEntry(slab, accountIdx, wallet);
  if (!saved || !entryRecordCurrent(saved, effectiveSizeQ)) return { entryE6: 0n, riskEntryE6: 0n, busyFeeAtoms: null };
  return { entryE6: saved.entryPriceE6, riskEntryE6: saved.bookedPriceE6, busyFeeAtoms: saved.busyFeeAtoms };
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

/**
 * The busy-side fee (atoms) to save with the entry after a trade, mirroring `entryAfterTrade` (same validity rules for reduce / add):
 *   - flat after                     → null
 *   - opened from flat, or flipped   → this fill's busy fee (null when it is unknown)
 *   - reduced                        → the prior amount scaled to the remaining size (a per-unit amount keeps its rate)
 *   - added                          → the prior amount scaled to the size before the add, plus this fill's busy fee
 * Null whenever the prior amount, the record or this fill's amount is unknown: unknown is never counted as zero.
 */
export function busyFeeAfterTrade(a: {
  beforeQ: bigint;
  afterQ: bigint;
  saved: Pick<SavedEntry, "entryPriceE6" | "sizeQ" | "busyFeeAtoms"> | null;
  fillBusyFeeAtoms: bigint | null;
}): bigint | null {
  const { beforeQ, afterQ, saved, fillBusyFeeAtoms } = a;
  if (afterQ === 0n) return null;
  const opened = beforeQ === 0n || (beforeQ > 0n) !== (afterQ > 0n);
  if (opened) {
    if (fillBusyFeeAtoms === null || fillBusyFeeAtoms < 0n) return null;
    // A flip: the fill's busy-side fee is charged on the WHOLE fill, but only the part that opens the new side belongs to the new position
    // (lib/trade-book.ts applyFill gives it `fee x openQ / |q|`), so the closing part's share is not carried (it would be subtracted twice).
    if (beforeQ !== 0n) {
      const fillQ = absQ(afterQ - beforeQ);
      return fillQ === 0n ? null : (fillBusyFeeAtoms * absQ(afterQ) + fillQ / 2n) / fillQ;
    }
    return fillBusyFeeAtoms;
  }
  if (!saved || saved.entryPriceE6 <= 0n || saved.sizeQ === null || saved.busyFeeAtoms === null) return null;
  if ((saved.sizeQ > 0n) !== (beforeQ > 0n) || absQ(beforeQ) > absQ(saved.sizeQ)) return null;
  const before = absQ(beforeQ);
  const after = absQ(afterQ);
  const savedSize = absQ(saved.sizeQ);
  const half = savedSize / 2n;
  const priorBefore = (saved.busyFeeAtoms * before + half) / savedSize;
  if (after <= before) return (priorBefore * after + before / 2n) / before;
  if (fillBusyFeeAtoms === null || fillBusyFeeAtoms < 0n) return null;
  return priorBefore + fillBusyFeeAtoms;
}

/** Clear saved entry price (call when position is fully closed). */
export function clearEntryPrice(slab: string, accountIdx: number, wallet?: string, opts?: { flat?: boolean }): void {
  try {
    localStorage.removeItem(key(slab, accountIdx, wallet));
    // A close to flat ends the position the "unknown" marker was about.
    if (opts?.flat) localStorage.removeItem(unknownKey(slab, accountIdx, wallet));
  } catch {
    // ignore
  }
}

/**
 * Council r10 recheck D6: after a reduce (a partial close) the remaining position keeps its average, so the saved record moves to the new size
 * instead of going stale (a record for the old size reads as "unknown entry"). Only when the reduce is reconciled: the record was current for the
 * size the chain held right before the fill, and the fill is a pure reduce (same side, smaller, not flat). The busy-side fee share scales with the
 * size left (busyFeeAfterTrade). A position carrying the explicit "unknown" marker is left alone. Returns true when it saved.
 */
export function keepEntryAfterReduce(slab: string, accountIdx: number, wallet: string | undefined, beforeQ: bigint, afterQ: bigint, sig?: string | null, prevChange?: string | null): boolean {
  if (beforeQ === 0n || afterQ === 0n || (beforeQ > 0n) !== (afterQ > 0n) || absQ(afterQ) >= absQ(beforeQ)) return false;
  if (isEntryMarkedUnknown(slab, accountIdx, wallet, beforeQ)) return false;
  const saved = getSavedEntry(slab, accountIdx, wallet);
  if (!saved || saved.sizeQ === null || saved.sizeQ !== beforeQ) return false;
  // Council r10 round 2 MED: when the chain's newest change before this reduce is known, the record must be the one that includes it (a
  // same-size close + reopen elsewhere keeps the size, not the Entry). Not kept otherwise: the chain rebuild fills it in.
  if (prevChange !== undefined && (saved.lastSig === null || saved.lastSig !== prevChange)) return false;
  const busy = busyFeeAfterTrade({ beforeQ, afterQ, saved: { entryPriceE6: saved.entryPriceE6, sizeQ: beforeQ, busyFeeAtoms: saved.busyFeeAtoms }, fillBusyFeeAtoms: null });
  saveEntryPrice(slab, accountIdx, saved.entryPriceE6, saved.leverage ?? undefined, wallet, afterQ, {
    bookedPriceE6: saved.bookedPriceE6,
    busyFeeAtoms: busy,
    ...(saved.chainSig ? { chainSig: saved.chainSig } : {}),
    // The reduce is now the newest change the record includes. Without its signature the record cannot be checked against the chain any more.
    ...(sig ? { lastSig: sig } : {}),
  });
  return true;
}
