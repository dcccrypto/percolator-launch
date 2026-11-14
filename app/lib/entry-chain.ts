/**
 * r10 owner decision 6: the Entry (average fill price) rebuilt from the trader's ON-CHAIN fills, so every device and browser profile shows the
 * same Entry, after a partial close, a lost session, or on a browser that never placed the trade.
 *
 * Source. The wrapper writes one FILL event per trade into the transaction logs (lib/v22/exec-fill.ts decodes it with the strict frame walk).
 * `getSignaturesForAddress(<taker portfolio>)` lists the transactions that touched the portfolio, newest first. Walking BACK from the position
 * the chain holds now, each fill undoes itself (`q_before = q_after - executed_q`); the walk ends at the fill the position was flat before. That
 * fill and everything after it are the whole life of the current position, and the average is rebuilt forward with the same rules the ticket uses
 * when it saves an entry (lib/entry-price.ts entryAfterTrade / busyFeeAfterTrade): an open sets it, an add averages, a reduce keeps it, a flip
 * restarts it.
 *
 * Which source wins. A chain-derived entry beats the device cache, but only when the history was read COMPLETELY and the fills add up to the
 * position the chain holds now. Anything else (the RPC could not be read, the page limit was reached before the open, a REDUCE the units of which
 * cannot be reconciled, the size does not add up because of silent ADL scaling, a fee that base + the matcher's own request cannot explain) returns
 * a verdict other than "chain" and the caller leaves the device cache exactly as it was: never a guess. (A silent ADL scaling that exactly cancels
 * the last add would still read as a flat start; that coincidence is not detectable from the logs alone and is listed as a residual risk.)
 *
 * Price of a fill. The booked price is the FILL's `price_e6`. The price the trader EFFECTIVELY paid adds the matcher's spread, which the wrapper
 * charges through `fee_atoms`: fee = base fee + spread (+ the growth busy-side fee on an OPEN). The Entry is booked +/- (fee - base) / |q|, the
 * same arithmetic as the ticket (`effectivePriceE6`), so the two devices agree to the last digit. Owner decision 2 (the r9 "unknown" rule) is
 * kept: on a market that can charge a busy-side fee, the chain cannot prove the busy rate (it is the side's utilisation just before the trade),
 * so a fill whose fee is not base + the matcher's own request within rounding is NOT priced: the Entry is unknown, as on the trading device.
 * A device that placed such a trade also leaves an explicit "unknown" marker (lib/entry-price.ts) the rebuild never overwrites.
 *
 * Bounds (Council r10 recheck D6). Keeper cranks land on a trader's portfolio about every 20 s while a position is open and change nothing, so
 * the walk must not spend its budget on them:
 *   - a transaction that does not name the wrapper program among its accounts cannot have touched the position and is skipped unread for
 *     events (a third party cannot push the walk to "unknown" with a truncated log in a transaction that never ran the wrapper);
 *   - `maxTx` (default 60) counts only transactions that CHANGED this position (a fill or a REDUCE); `maxRead` (default 2,000, about 11 hours
 *     of cranks at one every ~20 s) bounds every transaction read, cranks included;
 *   - reads go in batches (`getTransactions`, one HTTP request) when the connection has it, paced by `paceMs` between batches;
 *   - `resume`: the position as an earlier walk rebuilt it at `topSig`. A later rebuild reads only the transactions newer than that and joins
 *     them on, so a position held for days costs only what changed since the last look.
 * A rebuild is due per portfolio and size (lib/entry-chain-sync.ts rebuildDue: re-checked each minute after a complete read, cooled down otherwise).
 *
 * Funding (Council r10 recheck D1). The opening fill of a position opened by this app carries the portfolio's funding counter in a memo
 * (lib/funding-memo.ts). The walk keeps it on that fill, so `bookFromDeltas` can rebuild the trade book behind the Trade result on any device:
 * the same fills, fees and funding base the trading device recorded.
  */
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeTxEventsV22 } from "@/lib/v22/sdk/v22-fill-events";
import { execFillFromLogs, quotedSpreadBpsFloor, type ExecFill } from "@/lib/v22/exec-fill";
import { busyFeeAfterTrade, entryAfterTrade } from "@/lib/entry-price";
import { fundingBaseFromTx } from "@/lib/funding-memo";
import { applyFill, type Book } from "@/lib/trade-book";

/** REDUCE reasons whose `signed_reduced_q` is in ADL-effective position units (the same unit as the fills' executed_q). */
const EFFECTIVE_UNIT_REDUCE = new Set([2, 3, 6, 7, 8]);

export type ChainEntryVerdict =
  | "chain" // read completely, adds up to the position the chain holds: the result below is the Entry
  | "no-position" // the chain position is flat or unknown
  | "unreadable" // an RPC error: nothing was learned
  | "incomplete" // the page / transaction limit was reached before the open, or the history ended without a flat start
  | "mismatch" // the fills do not add up to the current position (silent ADL scaling, a trade the decoder cannot read)
  | "unexplained"; // a fee that base + spread (+ busy on an open) cannot explain

export interface ChainEntry {
  /** The price the trader effectively paid, averaged over the position (e6). Null when a fill's price could not be split from its fee. */
  entryPriceE6: bigint | null;
  /** The engine's basis: the average BOOKED price (e6). */
  bookedPriceE6: bigint;
  /** The busy-side fee paid to open the position, atoms (whole position). Null when unknown. */
  busyFeeAtoms: bigint | null;
  /** The signed effective size the entry describes (= the chain's now). */
  sizeQ: bigint;
  /** Fills used (oldest first). */
  fills: number;
}

export interface ChainEntryResult {
  verdict: ChainEntryVerdict;
  entry: ChainEntry | null;
  /** Transactions read (the RPC cost). */
  txRead: number;
  /** The newest signature on the portfolio when the walk started (any transaction): the record is only vouched for while it is still the newest. */
  topSig?: string;
  /** The signatures of the changes that make up the current position (set when the walk reached its start): lets a caller tell whether a given transaction belongs to it. */
  positionSigs?: string[];
  /** The changes that make up the current position, OLDEST first (set with `positionSigs`): what a later walk resumes from. */
  positionDeltas?: ChainDelta[];
  /** The size the first of `positionDeltas` started from (0 = flat; the other side when it flipped through flat). */
  startQ?: bigint;
  /** Transactions that changed this position among those read (what `maxTx` bounds). */
  changesRead?: number;
}

/** A stored walk to continue from: the current position's changes (oldest first) as they stood at `topSig`. */
export interface ChainResume {
  topSig: string;
  qAtTop: bigint;
  startQ: bigint;
  deltas: ChainDelta[];
}

/** One change of the position, from a landed transaction. */
export interface ChainDelta {
  sig: string;
  /** Signed change of the position (effective units). */
  deltaQ: bigint;
  /** Present for a fill; absent for a REDUCE (ADL, liquidation...), which changes size but never the average price. */
  fill?: ExecFill;
  /** The `fee_bps` the taker signed (TradeCpi instruction data); null = the instruction could not be found / decoded. */
  signedFeeBps?: bigint | null;
  /** The market's own no-busy cap for that transaction's matcher context (what `fetchTradeFeeBps` signs with no busy rate); null = not readable. */
  noBusyCap?: NoBusyCap | null;
  /** The funding counter the transaction's memo states (lib/funding-memo.ts); null / absent = none. Meaningful only on an opening fill. */
  fundingBase?: bigint | null;
}

/** The fee cap an order with NO busy rate signs, and the market maximum it is clamped to. */
export interface NoBusyCap {
  feeBps: bigint;
  maxFeeBps: bigint;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * The changes one transaction made to `portfolio`'s position on `market`: its fills (summed) and any REDUCE. null = the log cannot be trusted
 * (truncated / unknown frames): the caller treats the history as unreadable, never as "no change".
 */
export function deltasFromLogs(
  sig: string,
  logs: readonly string[] | null | undefined,
  succeeded: boolean,
  wrapper: PublicKey,
  o: { market: PublicKey; portfolio: PublicKey; assetIndex: number },
  signed: { feeBps: bigint | null; noBusyCap: NoBusyCap | null } = { feeBps: null, noBusyCap: null },
): ChainDelta[] | null | "irreconcilable" {
  if (!succeeded) return [];
  const ev = decodeTxEventsV22(true, logs, wrapper);
  if (ev.status !== "known") return null;
  // An event the decoder skipped (unknown kind / version / REDUCE reason, bad length) may be a change to this position: never read as "no change".
  if (ev.skipped.length > 0) return null;
  const out: ChainDelta[] = [];
  let fillAt = -1;
  const reduces: { at: number; d: ChainDelta }[] = [];
  ev.events.forEach((e, at) => {
    if (e.kind === "reduce" && e.market.equals(o.market) && e.portfolio.equals(o.portfolio) && e.assetIndex === o.assetIndex) {
      reduces.push({ at, d: { sig, deltaQ: e.signedReducedQ, ...(EFFECTIVE_UNIT_REDUCE.has(e.reason) ? {} : { unit: true }) } as ChainDelta });
    }
    if (e.kind === "fill" && e.market.equals(o.market) && e.taker.equals(o.portfolio) && fillAt < 0) fillAt = at;
  });
  if (reduces.some((r) => (r.d as ChainDelta & { unit?: boolean }).unit)) return "irreconcilable";
  let fillDelta: ChainDelta | null = null;
  if (fillAt >= 0) {
    const f = execFillFromLogs(logs, wrapper, { market: o.market, assetIndex: o.assetIndex, taker: o.portfolio, succeeded: true });
    // A fill of ours the decoder cannot reduce to one price (two assets in one line...) cannot be reconciled.
    if (!f) return "irreconcilable";
    fillDelta = { sig, deltaQ: f.executedQ, fill: f, signedFeeBps: signed.feeBps, noBusyCap: signed.noBusyCap };
  }
  // Keep the log order: the summed fill sits where its first FILL event was (REDUCEs before it happen before it).
  for (const r of reduces.filter((r) => r.at < fillAt || fillAt < 0)) out.push(r.d);
  if (fillDelta) out.push(fillDelta);
  for (const r of reduces.filter((r) => fillAt >= 0 && r.at > fillAt)) out.push(r.d);
  return out;
}

/**
 * The `fee_bps` a TradeCpi instruction signed, from the transaction's own instruction data (wrapper tag 10: 85 bytes, `fee_bps` u64 at 67),
 * and the matcher context it named (account 5). Null when the transaction holds no such instruction for this asset, or several (a batch, an
 * evict-and-trade, a wrapper call by another program): the signed cap is then not provable.
 */
export function signedFeeFromTx(
  message: { staticAccountKeys?: readonly PublicKey[]; compiledInstructions?: readonly { programIdIndex: number; data: Uint8Array; accountKeyIndexes?: readonly number[] }[] } | null | undefined,
  wrapper: PublicKey,
  assetIndex: number,
): { feeBps: bigint; matcherCtx: PublicKey | null } | null {
  const keys = message?.staticAccountKeys;
  const ixs = message?.compiledInstructions;
  if (!keys || !ixs) return null;
  let found: { feeBps: bigint; matcherCtx: PublicKey | null } | null = null;
  let n = 0;
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(wrapper) || ix.data[0] !== 10 || ix.data.length < 85) continue;
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
    if (dv.getUint16(41, true) !== assetIndex) continue;
    n++;
    const ci = ix.accountKeyIndexes?.[5];
    found = { feeBps: dv.getBigUint64(67, true), matcherCtx: ci === undefined ? null : keys[ci] ?? null };
  }
  return n === 1 ? found : null;
}

/** Back-compat helper: the signed fee only. */
export function signedFeeBpsFromTx(message: Parameters<typeof signedFeeFromTx>[0], wrapper: PublicKey, assetIndex: number): bigint | null {
  return signedFeeFromTx(message, wrapper, assetIndex)?.feeBps ?? null;
}

/**
 * The price a fill effectively paid, from the fill alone. Null = not explained (the Entry is then UNKNOWN, owner decision 2).
 *
 * `mayChargeBusy` false (no growth record): spread = fee - base, bit-identical to `effectivePriceE6(f, base, null)` whenever the fee is base + the
 * matcher's own request (checked on every market, below); otherwise unknown.
 *
 * `mayChargeBusy` true: the ticket compares the charged fee with the busy rate it QUOTED from the side's utilisation just before the trade,
 * state standard RPC cannot read back, and shows the Entry as unknown when they differ (or when a raised-fee Custom order was sent). Device 2
 * shows a number only when the chain PROVES no busy rate was quoted AND none was charged:
 *   - charged: the fee is base + the matcher's own request within rounding (no busy part above tolerance, none below);
 *   - quoted: the SIGNED `fee_bps` (instruction data) EQUALS the market's own no-busy cap, the value `fetchTradeFeeBps` /
 *     `resolveTradeFeeBps` produce with no busy rate (base + the matcher's worst-case fee + the SDK margin, clamped to the market maximum). A
 *     confirmed order signs room for its busy rate (above the cap), a raised-fee retry signs the util maximum (above), and a changed config
 *     shows as a different value: all unknown. A signed value at the market maximum is unknown too (a clamp could hide busy room).
 * No signed value (batch / unreadable instruction) or no readable cap = not provable = unknown. The cap is read from the market and matcher
 * context as they are NOW (history is not readable by standard RPC); if their inputs changed since the fill, the values differ and the Entry is
 * unknown: fail closed. Residual: an admin change that raises the cap by exactly a later-quoted busy rate could match.
 */
export function chainFillPrice(
  f: ExecFill,
  baseFeeBps: bigint,
  mayChargeBusy: boolean,
  signedFeeBps: bigint | null = null,
  noBusyCap: NoBusyCap | null = null,
): { priceE6: bigint; busyAtoms: bigint } | null {
  if (f.executedQ === 0n) return null;
  const base = (f.notionalAtoms * baseFeeBps) / 10_000n;
  const rest = f.feeAtoms > base ? f.feeAtoms - base : 0n;
  // The charged check runs on EVERY market: the fee must be base + the matcher's own request within rounding. On a non-growth market this also
  // makes a base-fee change after the fill (the authority can set it any time) fail closed instead of moving the Entry by the difference.
  const tol = f.notionalAtoms / 1_000_000n + 5n;
  const expected = f.quotedPriceE6 > 0n ? (f.notionalAtoms * quotedSpreadBpsFloor(f.bookedPriceE6, f.quotedPriceE6)) / 10_000n : 0n;
  const off = rest > expected ? rest - expected : expected - rest;
  if (off > tol) return null;
  if (mayChargeBusy) {
    if (signedFeeBps === null || noBusyCap === null) return null;
    if (signedFeeBps !== noBusyCap.feeBps || signedFeeBps >= noBusyCap.maxFeeBps) return null;
  }
  const perUnit = (rest * 1_000_000n) / abs(f.executedQ);
  const p = f.executedQ > 0n ? f.bookedPriceE6 + perUnit : f.bookedPriceE6 - perUnit;
  return p > 0n ? { priceE6: p, busyAtoms: 0n } : null;
}

/**
 * Rebuilds the Entry from the position's changes, OLDEST FIRST, `deltas[0]` being the change that took the position from flat (or, when it
 * flipped through flat, from `startQ` on the other side: only its opening half belongs to the position). Pure.
 * Returns null when the changes do not end at `qNow`.
 */
export function rebuildEntry(deltas: readonly ChainDelta[], qNow: bigint, baseFeeBps: bigint, startQ = 0n, mayChargeBusy = true): { verdict: "chain" | "mismatch" | "unexplained"; entry: ChainEntry | null } {
  let q = startQ;
  type Saved = { entryPriceE6: bigint; sizeQ: bigint | null; busyFeeAtoms: bigint | null };
  type Booked = { entryPriceE6: bigint; sizeQ: bigint | null };
  let saved = null as Saved | null;
  let booked = null as Booked | null;
  let entryKnown = true;
  let fills = 0;
  for (const d of deltas) {
    const after = q + d.deltaQ;
    const opens = q === 0n || (q > 0n) !== (after > 0n) || abs(after) > abs(q);
    if (d.fill) {
      fills++;
      const px = chainFillPrice(d.fill, baseFeeBps, mayChargeBusy, d.signedFeeBps ?? null, d.noBusyCap ?? null);
      if (px === null && opens) return { verdict: "unexplained", entry: null };
      if (after === 0n) {
        saved = null;
        booked = null;
        entryKnown = true;
      } else {
        const nextEntry = entryAfterTrade({ beforeQ: q, afterQ: after, saved: saved ? { entryPriceE6: saved.entryPriceE6, sizeQ: q } : null, fillPriceE6: px?.priceE6 ?? 0n });
        const nextBooked = entryAfterTrade({ beforeQ: q, afterQ: after, saved: booked ? { entryPriceE6: booked.entryPriceE6, sizeQ: q } : null, fillPriceE6: d.fill.bookedPriceE6 });
        const nextBusy = busyFeeAfterTrade({ beforeQ: q, afterQ: after, saved: saved ? { entryPriceE6: saved.entryPriceE6, sizeQ: q, busyFeeAtoms: saved.busyFeeAtoms } : null, fillBusyFeeAtoms: px ? px.busyAtoms : null });
        entryKnown = nextEntry !== null;
        saved = { entryPriceE6: nextEntry ?? 0n, sizeQ: after, busyFeeAtoms: nextBusy };
        booked = { entryPriceE6: nextBooked ?? d.fill.bookedPriceE6, sizeQ: after };
      }
    } else if (after === 0n) {
      saved = null;
      booked = null;
    } else if (saved && booked) {
      // A REDUCE (ADL, liquidation): the average stays, the busy-side fee share scales with the size left.
      const busy = busyFeeAfterTrade({ beforeQ: q, afterQ: after, saved: { entryPriceE6: saved.entryPriceE6, sizeQ: q, busyFeeAtoms: saved.busyFeeAtoms }, fillBusyFeeAtoms: null });
      saved = { ...saved, sizeQ: after, busyFeeAtoms: busy };
      booked = { ...booked, sizeQ: after };
    }
    q = after;
  }
  if (q !== qNow || qNow === 0n || !saved || !booked) return { verdict: "mismatch", entry: null };
  return {
    verdict: "chain",
    entry: {
      entryPriceE6: entryKnown && saved.entryPriceE6 > 0n ? saved.entryPriceE6 : null,
      bookedPriceE6: booked.entryPriceE6,
      busyFeeAtoms: saved.busyFeeAtoms,
      sizeQ: qNow,
      fills,
    },
  };
}

export interface ChainEntryOptions {
  market: PublicKey;
  portfolio: PublicKey;
  assetIndex?: number;
  /** The signed ADL-effective size the chain holds now. */
  qNow: bigint;
  baseFeeBps: bigint;
  /** The market may charge a busy-side fee (a growth record exists). Default true (the stricter rule). */
  mayChargeBusy?: boolean;
  /** The market's no-busy cap for a transaction's matcher context (null context = none named). Absent / null result = growth fills are unknown. */
  noBusyCap?: (matcherCtx: PublicKey | null) => Promise<NoBusyCap | null>;
  /** Signatures per page (default 50). */
  pageSize?: number;
  /** Transactions that CHANGED this position read at most (default 60). Transactions that changed nothing are not counted here. */
  maxTx?: number;
  /** Transactions read at most, of any kind (default 2,000). */
  maxRead?: number;
  /** Transactions fetched at once (default 10). */
  concurrency?: number;
  /** Wait between fetch groups, ms (default 0). The page-level sync paces the shared RPC with it. */
  paceMs?: number;
  /** Continue an earlier walk (see the header). A resume that does not join up exactly is dropped and the walk starts over. */
  resume?: ChainResume | null;
}

type Conn = Pick<Connection, "getSignaturesForAddress" | "getTransaction"> & Partial<Pick<Connection, "getTransactions">>;
type TxResp = Awaited<ReturnType<Connection["getTransaction"]>>;

/** True when the transaction names `wrapper` among its accounts (static or loaded): only then can it have run the wrapper and changed a position. */
export function txNamesProgram(tx: { transaction?: { message?: unknown }; meta?: { loadedAddresses?: { writable?: readonly unknown[]; readonly?: readonly unknown[] } | null } | null } | null, program: PublicKey): boolean {
  const m = tx?.transaction?.message as { staticAccountKeys?: readonly PublicKey[]; accountKeys?: readonly PublicKey[] } | undefined;
  const keys = m?.staticAccountKeys ?? m?.accountKeys;
  // Unknown shape: cannot prove the wrapper did not run, so treat it as named (read its events).
  if (!keys) return true;
  const eq = (k: unknown): boolean => {
    if (k instanceof Object && typeof (k as PublicKey).equals === "function") return (k as PublicKey).equals(program);
    return typeof k === "string" && k === program.toBase58();
  };
  if (keys.some(eq)) return true;
  const la = tx?.meta?.loadedAddresses;
  return !!la && [...(la.writable ?? []), ...(la.readonly ?? [])].some(eq);
}

async function fetchTxs(connection: Conn, sigs: string[], conc: number): Promise<(TxResp | null)[]> {
  const cfg = { commitment: "confirmed" as const, maxSupportedTransactionVersion: 0 };
  if (typeof connection.getTransactions === "function") {
    const out: (TxResp | null)[] = [];
    for (let i = 0; i < sigs.length; i += conc) out.push(...((await connection.getTransactions(sigs.slice(i, i + conc), cfg)) as (TxResp | null)[]));
    return out;
  }
  const out: (TxResp | null)[] = [];
  for (let i = 0; i < sigs.length; i += conc) out.push(...(await Promise.all(sigs.slice(i, i + conc).map((s) => connection.getTransaction(s, cfg)))));
  return out;
}

/**
 * The trade book (lib/trade-book.ts) of the current position, rebuilt from its chain changes (oldest first). The same fill numbers the trading
 * device feeds its own book, plus the opening fill's funding memo as the funding base, so the Trade result and the close estimate agree on every
 * device. Null when it cannot be rebuilt: the position started by flipping through flat (its funding base is after a settle no memo can state),
 * or a REDUCE (ADL, liquidation) changed it (the book follows fills only). A missing memo gives a book whose funding base is unknown.
 */
export function bookFromDeltas(deltas: readonly ChainDelta[], startQ: bigint, qNow: bigint): Book | null {
  if (startQ !== 0n || deltas.length === 0) return null;
  let book: Book | null = null;
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    if (!d.fill) return null;
    const base = i === 0 && d.fundingBase != null ? { netPaid: d.fundingBase, legs: 1 } : null;
    book = applyFill(book, { q: d.fill.executedQ, bookedPriceE6: d.fill.bookedPriceE6, feeAtoms: d.fill.feeAtoms, funding: base, sig: d.sig }).book;
    if (i === 0 && book && d.fundingBase == null) book = { ...book, fundingBase: null };
  }
  return book && book.q === qNow ? book : null;
}

/**
 * Walks the portfolio's transactions newest to oldest and rebuilds the Entry. Never throws. See the header for what each verdict means.
 */
export async function entryFromChain(connection: Conn, wrapper: PublicKey, o: ChainEntryOptions): Promise<ChainEntryResult> {
  const assetIndex = o.assetIndex ?? 0;
  const pageSize = o.pageSize ?? 50;
  const maxTx = o.maxTx ?? 60;
  const maxRead = o.maxRead ?? 2000;
  const conc = Math.max(1, o.concurrency ?? 10);
  const pace = o.paceMs ?? 0;
  const resume = o.resume ?? null;
  if (o.qNow === 0n) return { verdict: "no-position", entry: null, txRead: 0 };
  const newestFirst: ChainDelta[] = [];
  let q = o.qNow; // the position AFTER the change being examined
  let txRead = 0;
  let changesRead = 0;
  let before: string | undefined;
  let flip: { len: number; startQ: bigint } | null = null;
  let topSig: string | undefined;
  const finish = (used: ChainDelta[], startQ: bigint): ChainEntryResult => {
    const oldestFirst = used.slice().reverse();
    const r = rebuildEntry(oldestFirst, o.qNow, o.baseFeeBps, startQ, o.mayChargeBusy ?? true);
    return { verdict: r.verdict, entry: r.entry, txRead, topSig, positionSigs: used.map((d) => d.sig), positionDeltas: oldestFirst, startQ, changesRead };
  };
  try {
    for (;;) {
      const page = await connection.getSignaturesForAddress(o.portfolio, { limit: pageSize, ...(before ? { before } : {}) }, "confirmed");
      if (page.length === 0) return { verdict: "incomplete", entry: null, txRead, topSig, changesRead };
      if (topSig === undefined) topSig = page[0].signature;
      // Resume: everything at and below the stored top was read before. Stop at it.
      const stopAt = resume ? page.findIndex((s) => s.signature === resume.topSig) : -1;
      const sigs = (stopAt >= 0 ? page.slice(0, stopAt) : page).filter((s) => s.err === null).map((s) => s.signature);
      for (let i = 0; i < sigs.length; i += conc) {
        if (txRead >= maxRead || changesRead >= maxTx) return { verdict: "incomplete", entry: null, txRead, topSig, changesRead };
        if (i > 0 && pace > 0) await new Promise((r) => setTimeout(r, pace));
        const group = sigs.slice(i, i + conc).slice(0, maxRead - txRead);
        const txs = await fetchTxs(connection, group, conc);
        txRead += group.length;
        for (let j = 0; j < group.length; j++) {
          const tx = txs[j];
          if (!tx?.meta) return { verdict: "unreadable", entry: null, txRead, topSig, changesRead };
          // A transaction that never named the wrapper cannot have changed the position: skipped, not counted.
          if (tx.meta.err !== null || !txNamesProgram(tx as Parameters<typeof txNamesProgram>[0], wrapper)) continue;
          const msg = tx.transaction?.message as Parameters<typeof signedFeeFromTx>[0];
          const sf = signedFeeFromTx(msg, wrapper, assetIndex);
          const cap = sf && o.noBusyCap ? await o.noBusyCap(sf.matcherCtx).catch(() => null) : null;
          const ds = deltasFromLogs(group[j], tx.meta.logMessages, tx.meta.err === null, wrapper, { market: o.market, portfolio: o.portfolio, assetIndex }, { feeBps: sf?.feeBps ?? null, noBusyCap: cap });
          if (ds === null) return { verdict: "unreadable", entry: null, txRead, topSig, changesRead };
          if (ds === "irreconcilable") return { verdict: "mismatch", entry: null, txRead, topSig, changesRead };
          if (ds.length === 0) continue;
          changesRead++;
          const memo = ds.some((d) => d.fill) ? fundingBaseFromTx(msg as Parameters<typeof fundingBaseFromTx>[0]) : null;
          // Inside one transaction the changes are applied in order; undo them last to first.
          for (let k = ds.length - 1; k >= 0; k--) {
            const d = ds[k].fill && memo !== null ? { ...ds[k], fundingBase: memo } : ds[k];
            newestFirst.push(d);
            q -= d.deltaQ;
            // A change that flipped through flat starts the position with its opening half, but q_before is only the chain's size minus
            // the fills: silent ADL scaling would fake it. So the walk goes on until the earlier trade unwinds to flat exactly too.
            if (flip === null && flipsThrough(q, d.deltaQ)) flip = { len: newestFirst.length, startQ: q };
            if (q === 0n) return finish(flip ? newestFirst.slice(0, flip.len) : newestFirst, flip ? flip.startQ : 0n);
          }
        }
      }
      if (resume && stopAt >= 0) {
        // Joined the stored walk. It must meet it at exactly the size it stored; anything else (silent ADL scaling, a missed change) means
        // the stored part cannot be trusted: walk again from scratch.
        if (q === resume.qAtTop && resume.deltas.length > 0) {
          // The stored part was already walked down to its start, so a flip in the newer part is proven too.
          if (flip) return finish(newestFirst.slice(0, flip.len), flip.startQ);
          return finish([...newestFirst, ...resume.deltas.slice().reverse()], resume.startQ);
        }
        return entryFromChain(connection, wrapper, { ...o, resume: null });
      }
      before = page[page.length - 1].signature;
      if (page.length < pageSize) return { verdict: "incomplete", entry: null, txRead, topSig, changesRead };
    }
  } catch {
    return { verdict: "unreadable", entry: null, txRead, topSig, changesRead };
  }
}

/**
 * Council r10 round 2 MED: the signature of the newest transaction BEFORE `beforeSig` that changed this position (a fill or a REDUCE), read
 * from the portfolio's own list, skipping keeper cranks and anything that never ran the wrapper. The trade book and a device-written Entry
 * describe the position only while their newest fill is that change: a same-size close + reopen (or an add + reduce) on another device keeps
 * the size but not the history.
 *
 * `known`: an earlier walk's top signature and the newest change it found. Reaching `known.top` with no change in between returns
 * `known.newest` without reading further. Null when it cannot be told: `beforeSig` not on the list yet, an unreadable transaction, or
 * `maxRead` transactions read without finding a change.
 */
export async function prevChangeSig(
  connection: Conn,
  wrapper: PublicKey,
  o: { market: PublicKey; portfolio: PublicKey; assetIndex?: number; beforeSig: string; known?: { top: string; newest: string } | null; maxRead?: number; pageSize?: number },
): Promise<string | null> {
  const assetIndex = o.assetIndex ?? 0;
  const maxRead = o.maxRead ?? 300;
  const pageSize = o.pageSize ?? 50;
  let txRead = 0;
  let before: string | undefined;
  let found = false; // `beforeSig` seen: everything after it in the list is older
  try {
    for (;;) {
      const page = await connection.getSignaturesForAddress(o.portfolio, { limit: pageSize, ...(before ? { before } : {}) }, "confirmed");
      if (page.length === 0) return null;
      let list = page;
      if (!found) {
        // Listed newest first from the top (a `before` the node has not indexed yet is not reliable): it must be on the first page.
        const at = page.findIndex((s) => s.signature === o.beforeSig);
        if (at < 0) return null;
        found = true;
        list = page.slice(at + 1);
      }
      const knownAt = o.known ? list.findIndex((s) => s.signature === o.known?.top) : -1;
      const sigs = (knownAt >= 0 ? list.slice(0, knownAt) : list).filter((s) => s.err === null).map((s) => s.signature);
      for (let i = 0; i < sigs.length; i += 10) {
        if (txRead >= maxRead) return null;
        const group = sigs.slice(i, i + 10).slice(0, maxRead - txRead);
        const txs = await fetchTxs(connection, group, 10);
        txRead += group.length;
        for (let j = 0; j < group.length; j++) {
          const tx = txs[j];
          if (!tx?.meta) return null;
          if (tx.meta.err !== null || !txNamesProgram(tx as Parameters<typeof txNamesProgram>[0], wrapper)) continue;
          const ds = deltasFromLogs(group[j], tx.meta.logMessages, true, wrapper, { market: o.market, portfolio: o.portfolio, assetIndex });
          if (ds === null) return null;
          if (ds === "irreconcilable" || ds.length > 0) return group[j];
        }
      }
      if (knownAt >= 0 && o.known) return o.known.newest;
      if (page.length < pageSize) return null;
      before = page[page.length - 1].signature;
    }
  } catch {
    return null;
  }
}

/** True when undoing a change of `deltaQ` leaves `qBefore` on the OTHER side of flat from where the change ended: a flip, whose opening half starts the position. */
function flipsThrough(qBefore: bigint, deltaQ: bigint): boolean {
  const after = qBefore + deltaQ;
  return qBefore !== 0n && after !== 0n && (qBefore > 0n) !== (after > 0n);
}

// ── storage form of a walk (lib/entry-chain-sync.ts keeps it per portfolio) ─────────────────────────────────────────────────────────
type S = string;
export interface StoredDelta {
  sig: S;
  dq: S;
  f?: { b: S; q: S; fee: S; n: S; t: S; qp: S; l: number };
  sf?: S | null;
  cap?: { f: S; m: S } | null;
  fb?: S | null;
}
const isInt = (v: unknown): v is string => typeof v === "string" && /^-?\d+$/.test(v);

export function storeDeltas(ds: readonly ChainDelta[]): StoredDelta[] {
  return ds.map((d) => ({
    sig: d.sig,
    dq: d.deltaQ.toString(),
    ...(d.fill
      ? { f: { b: d.fill.bookedPriceE6.toString(), q: d.fill.executedQ.toString(), fee: d.fill.feeAtoms.toString(), n: d.fill.notionalAtoms.toString(), t: d.fill.taker.toBase58(), qp: d.fill.quotedPriceE6.toString(), l: d.fill.legs } }
      : {}),
    ...(d.signedFeeBps !== undefined ? { sf: d.signedFeeBps === null ? null : d.signedFeeBps.toString() } : {}),
    ...(d.noBusyCap !== undefined ? { cap: d.noBusyCap === null ? null : { f: d.noBusyCap.feeBps.toString(), m: d.noBusyCap.maxFeeBps.toString() } } : {}),
    ...(d.fundingBase != null ? { fb: d.fundingBase.toString() } : {}),
  }));
}

/** Back from storage; null when anything is malformed (the caller then walks from scratch). */
export function loadDeltas(raw: unknown, toKey: (s: string) => PublicKey): ChainDelta[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChainDelta[] = [];
  try {
    for (const r of raw as StoredDelta[]) {
      if (!r || typeof r.sig !== "string" || !isInt(r.dq)) return null;
      const d: ChainDelta = { sig: r.sig, deltaQ: BigInt(r.dq) };
      if (r.f) {
        const f = r.f;
        if (![f.b, f.q, f.fee, f.n, f.qp].every(isInt) || typeof f.t !== "string" || typeof f.l !== "number") return null;
        d.fill = { bookedPriceE6: BigInt(f.b), executedQ: BigInt(f.q), feeAtoms: BigInt(f.fee), notionalAtoms: BigInt(f.n), taker: toKey(f.t), quotedPriceE6: BigInt(f.qp), legs: f.l };
      }
      if (r.sf !== undefined) d.signedFeeBps = r.sf === null ? null : isInt(r.sf) ? BigInt(r.sf) : null;
      if (r.cap !== undefined) d.noBusyCap = r.cap && isInt(r.cap.f) && isInt(r.cap.m) ? { feeBps: BigInt(r.cap.f), maxFeeBps: BigInt(r.cap.m) } : null;
      if (isInt(r.fb)) d.fundingBase = BigInt(r.fb);
      out.push(d);
    }
  } catch {
    return null;
  }
  return out;
}
