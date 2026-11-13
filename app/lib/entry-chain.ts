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
 * Bounds. At most `maxTx` transactions are read per rebuild (default 60), in pages of `pageSize` signatures, sequentially in small groups; a
 * rebuild runs only for a position this device has no current entry for, at most once per cooldown per portfolio and size (memory + storage).
 *
 * What this does NOT rebuild: the trade book behind the "Trade result" (it also needs the funding counter at the open, which no transaction
 * records). That stays device-local.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeTxEventsV22 } from "@/lib/v22/sdk/v22-fill-events";
import { execFillFromLogs, quotedSpreadBpsFloor, type ExecFill } from "@/lib/v22/exec-fill";
import { busyFeeAfterTrade, entryAfterTrade } from "@/lib/entry-price";

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
  /**
   * The address whose signatures are walked (default: the portfolio). Fills are still filtered to this portfolio, market and asset. The trader's
   * WALLET signs every trade but not the keeper's cranks (which flood a trader portfolio's list), so walking it spends the transaction budget on
   * real trades. A keeper-signed REDUCE (liquidation) is not on the wallet's list: the sizes then do not add up and the caller falls back to the
   * portfolio walk.
   */
  walkAddress?: PublicKey;
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
  /** Transactions read at most (default 60). */
  maxTx?: number;
  /** Transactions fetched at once (default 4). */
  concurrency?: number;
}

type Conn = Pick<Connection, "getSignaturesForAddress" | "getTransaction">;

/**
 * Walks the portfolio's transactions newest to oldest and rebuilds the Entry. Never throws. See the header for what each verdict means.
 */
export async function entryFromChain(connection: Conn, wrapper: PublicKey, o: ChainEntryOptions): Promise<ChainEntryResult> {
  const assetIndex = o.assetIndex ?? 0;
  const pageSize = o.pageSize ?? 50;
  const maxTx = o.maxTx ?? 60;
  const conc = Math.max(1, o.concurrency ?? 4);
  if (o.qNow === 0n) return { verdict: "no-position", entry: null, txRead: 0 };
  const newestFirst: ChainDelta[] = [];
  let q = o.qNow; // the position AFTER the change being examined
  let txRead = 0;
  let before: string | undefined;
  let flip: { len: number; startQ: bigint } | null = null;
  let topSig: string | undefined;
  try {
    for (;;) {
      const page = await connection.getSignaturesForAddress(o.walkAddress ?? o.portfolio, { limit: pageSize, ...(before ? { before } : {}) }, "confirmed");
      if (page.length === 0) return { verdict: "incomplete", entry: null, txRead, topSig };
      if (topSig === undefined) topSig = page[0].signature;
      const sigs = page.filter((s) => s.err === null).map((s) => s.signature);
      for (let i = 0; i < sigs.length; i += conc) {
        if (txRead >= maxTx) return { verdict: "incomplete", entry: null, txRead, topSig };
        const group = sigs.slice(i, i + conc).slice(0, maxTx - txRead);
        const txs = await Promise.all(group.map((s) => connection.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
        txRead += group.length;
        for (let j = 0; j < group.length; j++) {
          const tx = txs[j];
          if (!tx?.meta) return { verdict: "unreadable", entry: null, txRead, topSig };
          const sf = signedFeeFromTx(tx.transaction?.message as Parameters<typeof signedFeeFromTx>[0], wrapper, assetIndex);
          const cap = sf && o.noBusyCap ? await o.noBusyCap(sf.matcherCtx).catch(() => null) : null;
          const ds = deltasFromLogs(group[j], tx.meta.logMessages, tx.meta.err === null, wrapper, { market: o.market, portfolio: o.portfolio, assetIndex }, { feeBps: sf?.feeBps ?? null, noBusyCap: cap });
          if (ds === null) return { verdict: "unreadable", entry: null, txRead, topSig };
          if (ds === "irreconcilable") return { verdict: "mismatch", entry: null, txRead, topSig };
          // Inside one transaction the changes are applied in order; undo them last to first.
          for (let k = ds.length - 1; k >= 0; k--) {
            newestFirst.push(ds[k]);
            q -= ds[k].deltaQ;
            // A change that flipped through flat starts the position with its opening half, but q_before is only the chain's size minus
            // the fills: silent ADL scaling would fake it. So the walk goes on until the earlier trade unwinds to flat exactly too.
            if (flip === null && flipsThrough(q, ds[k].deltaQ)) flip = { len: newestFirst.length, startQ: q };
            if (q === 0n) {
              const used = flip ? newestFirst.slice(0, flip.len) : newestFirst;
              const r = rebuildEntry(used.slice().reverse(), o.qNow, o.baseFeeBps, flip ? flip.startQ : 0n, o.mayChargeBusy ?? true);
              return { verdict: r.verdict, entry: r.entry, txRead, topSig, positionSigs: used.map((d) => d.sig) };
            }
          }
        }
      }
      before = page[page.length - 1].signature;
      if (page.length < pageSize) return { verdict: "incomplete", entry: null, txRead, topSig };
    }
  } catch {
    return { verdict: "unreadable", entry: null, txRead, topSig };
  }
}

/** True when undoing a change of `deltaQ` leaves `qBefore` on the OTHER side of flat from where the change ended: a flip, whose opening half starts the position. */
function flipsThrough(qBefore: bigint, deltaQ: bigint): boolean {
  const after = qBefore + deltaQ;
  return qBefore !== 0n && after !== 0n && (qBefore > 0n) !== (after > 0n);
}
