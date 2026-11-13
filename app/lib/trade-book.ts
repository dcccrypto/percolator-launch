/**
 * M7: the result of a TRADE, over its whole lifetime, from the FILLs the app saw.
 *
 * A close-only equity delta (the first version) left out the open-side fee and spread and any PnL the engine / crank had already
 * settled into the account, so a losing round trip could read as a gain. The book instead follows the position fill by fill, on the
 * wrapper's own numbers:
 *
 *     trade result = price PnL on BOOKED prices (every reduction against the average booked price)  -  every fee_atoms paid  -  funding paid
 *
 * `fee_atoms` carries the base fee AND the matcher's spread (fee channel), so the result includes both, for the open, the adds and the
 * close. Price PnL on booked (mark) prices does not depend on when the crank settled it. FUNDING IS included (r10 owner decision 1): the
 * book keeps the portfolio's funding counter as it stood when the trade opened (`fundingBase`), and the close subtracts the counter after
 * the finishing fill (lib/funding-flow.ts: exactly what the chain moved on the position). A trade whose funding counters could not be read at
 * either end has an UNKNOWN result (null), never one that silently leaves funding out. The book is kept per wallet + market + taker portfolio
 * on this device. A trade whose start the app did not see (opened elsewhere, before this build, size
 * changed by ADL) has no book: its result is UNKNOWN and nothing is claimed.
 */
import type { FundingSample } from "@/lib/funding-flow";

export interface Book {
  /** Signed position size (engine units) the book follows. */
  q: bigint;
  /** Average booked price of the open position, e6. */
  avgE6: bigint;
  /** Fees paid since the trade opened, atoms. */
  fees: bigint;
  /** Price PnL realized by reductions so far, atoms. */
  pnl: bigint;
  /** The portfolio's net funding counter (paid - received, atoms) when this trade opened; null = it could not be read (result unknown). */
  fundingBase: bigint | null;
}

export interface FillIn {
  /** Signed executed size. */
  q: bigint;
  bookedPriceE6: bigint;
  feeAtoms: bigint;
  /** The portfolio's funding counters sampled at the slot of THIS fill (after it). Absent / null = not read. */
  funding?: FundingSample | null;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/** The funding counter after a fill, when the sample matches what the portfolio should hold (one leg if a position remains, none if flat). */
function fundingAfter(f: FillIn, remaining: bigint): bigint | null {
  const s = f.funding;
  if (!s) return null;
  return s.legs === (remaining === 0n ? 0 : 1) ? s.netPaid : null;
}

/**
 * Applies one fill. `closedResult` is the finished trade's result when this fill takes the position to flat (or through it), funding
 * included; null when the funding at either end was not read. `closedFunding` is the funding part of it (paid positive) when known.
 */
export function applyFill(book: Book | null, f: FillIn): { book: Book | null; closedResult: bigint | null; closedFunding: bigint | null } {
  if (f.q === 0n) return { book, closedResult: null, closedFunding: null };
  if (!book || book.q === 0n) return { book: { q: f.q, avgE6: f.bookedPriceE6, fees: f.feeAtoms, pnl: 0n, fundingBase: fundingAfter(f, f.q) }, closedResult: null, closedFunding: null };
  const sameSide = (book.q > 0n) === (f.q > 0n);
  if (sameSide) {
    const total = abs(book.q) + abs(f.q);
    const avg = (abs(book.q) * book.avgE6 + abs(f.q) * f.bookedPriceE6) / total;
    return { book: { q: book.q + f.q, avgE6: avg, fees: book.fees + f.feeAtoms, pnl: book.pnl, fundingBase: book.fundingBase }, closedResult: null, closedFunding: null };
  }
  const closeQ = abs(f.q) < abs(book.q) ? abs(f.q) : abs(book.q);
  const dir = book.q > 0n ? 1n : -1n;
  const pnl = book.pnl + (dir * closeQ * (f.bookedPriceE6 - book.avgE6)) / 1_000_000n;
  // The fill's fee is shared between the part that closes and any part that opens the other side.
  const feeClosing = (f.feeAtoms * closeQ) / abs(f.q);
  const fees = book.fees + feeClosing;
  const remaining = book.q + f.q;
  if (remaining !== 0n && (remaining > 0n) === (book.q > 0n)) return { book: { q: remaining, avgE6: book.avgE6, fees, pnl, fundingBase: book.fundingBase }, closedResult: null, closedFunding: null };
  // The trade ends here (flat, or through to the other side): its funding is the counter now minus the counter at its open.
  const end = fundingAfter(f, remaining);
  const funding = end !== null && book.fundingBase !== null ? end - book.fundingBase : null;
  const closedResult = funding === null ? null : pnl - fees - funding;
  if (remaining === 0n) return { book: null, closedResult, closedFunding: funding };
  return { book: { q: remaining, avgE6: f.bookedPriceE6, fees: f.feeAtoms - feeClosing, pnl: 0n, fundingBase: end }, closedResult, closedFunding: funding };
}

/** The book is only trusted while it matches the chain: a different size (ADL, another device) means the history is incomplete. */
export function reconcile(book: Book | null, onChainQ: bigint): Book | null {
  if (!book) return null;
  return book.q === onChainQ ? book : null;
}

// ── persistence (device-local) ───────────────────────────────────────────────────────────────────────────────────────────────────
const KEY = (wallet: string, slab: string, portfolio: string) => `perc:tradebook:v1:${wallet}:${slab}:${portfolio}`;

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadBook(wallet: string, slab: string, portfolio: string): Book | null {
  try {
    const raw = store()?.getItem(KEY(wallet, slab, portfolio));
    if (!raw) return null;
    const j = JSON.parse(raw) as Record<string, string | null>;
    const ok = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);
    if (!ok(j.q) || !ok(j.avgE6) || !ok(j.fees) || !ok(j.pnl)) return null;
    // A book saved before r10 has no funding base: its funding is unknown, so its result will be too (never one without funding).
    return { q: BigInt(j.q), avgE6: BigInt(j.avgE6), fees: BigInt(j.fees), pnl: BigInt(j.pnl), fundingBase: ok(j.fundingBase) ? BigInt(j.fundingBase) : null };
  } catch {
    return null;
  }
}

export function saveBook(wallet: string, slab: string, portfolio: string, book: Book | null): void {
  try {
    const st = store();
    if (!st) return;
    if (!book) st.removeItem(KEY(wallet, slab, portfolio));
    else st.setItem(KEY(wallet, slab, portfolio), JSON.stringify({ q: book.q.toString(), avgE6: book.avgE6.toString(), fees: book.fees.toString(), pnl: book.pnl.toString(), fundingBase: book.fundingBase === null ? null : book.fundingBase.toString() }));
  } catch {
    /* storage unavailable: no result is claimed later (the book is simply absent) */
  }
}

/**
 * Applies a landed fill to the stored book and returns the finished trade's result (null = no finished trade, or its start was not
 * seen). `onChainQBefore` is the position (signed, effective) the chain had BEFORE this fill: the book must match it.
 */
export function recordFill(wallet: string, slab: string, portfolio: string, f: FillIn, onChainQBefore: bigint): bigint | null {
  const trusted = reconcile(loadBook(wallet, slab, portfolio), onChainQBefore);
  // Flat before and the fill opens: a fresh book (its whole life is seen). Anything else without a matching book: history unknown.
  if (!trusted && onChainQBefore !== 0n) {
    saveBook(wallet, slab, portfolio, null);
    return null;
  }
  const r = applyFill(trusted, f);
  saveBook(wallet, slab, portfolio, r.book);
  return r.closedResult;
}

/**
 * The book of a wallet's position on a market when the taker portfolio is not at hand (the Portfolio and dock estimates): the one stored book
 * under this wallet + market. Two or more (should not happen: one taker portfolio per wallet and market) read as none.
 */
export function loadBookByWallet(wallet: string, slab: string): Book | null {
  try {
    const st = store();
    if (!st) return null;
    const prefix = `perc:tradebook:v1:${wallet}:${slab}:`;
    let found: Book | null = null;
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      if (found) return null;
      found = loadBook(wallet, slab, k.slice(prefix.length));
      if (!found) return null;
    }
    return found;
  } catch {
    return null;
  }
}
