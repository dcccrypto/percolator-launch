/**
 * r10 owner decision 6: puts a chain-derived Entry (lib/entry-chain.ts) into the entry cache every surface already reads, so no surface changes.
 *
 * When it runs: for every open position (no record, a record for another size, a back-solved estimate, and a current record too). A record of
 * the same size is not proof (Council r10 round 2 MED: a same-size close + reopen on another device): a record this device wrote stands only
 * while its newest fill (`lastSig`) is the position's newest change on chain, and is then re-checked like a chain record (one
 * getSignaturesForAddress while nothing changed). Which source wins: a chain-derived entry replaces any record the chain does not confirm; when
 * the chain history cannot be read completely the device cache is left exactly as it was (nothing is written, nothing guessed).
 *
 * Bounds (devnet RPC is shared): one rebuild at a time per page (a module-level queue), the walk's own bounds (lib/entry-chain.ts), paced at
 * about `PACE_TX_PER_S` transactions a second, and a cooldown per portfolio and size: a completed rebuild is not repeated for that size; an unreadable / incomplete one waits
 * `COOLDOWN_MS` (10 min) unless the size changed. The memory map and the storage record both carry it, so a reload does not retry at once.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { bookFromDeltas, entryFromChain, loadDeltas, storeDeltas, walletChangeCheck, type ChainEntryResult, type ChainEntryVerdict, type ChainResume, type NoBusyCap, type StoredDelta } from "@/lib/entry-chain";
import { loadBook, saveBook } from "@/lib/trade-book";
import { resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { clearEntryPrice, clearEntryUnknownMark, entryRecordCurrent, getEntryLeverage, getEntryUnknownMark, getSavedEntry, isEntryMarkedUnknown, saveEntryPrice, type SavedEntry } from "@/lib/entry-price";
import { readEffectivePositionQ } from "@/lib/position-change";
import { __resetChainSyncHoldsForTests, chainSyncHeld, holdChainSync } from "@/lib/entry-chain-hold";
export { chainSyncHeld, holdChainSync };
import { growthRecordPresence } from "@/lib/v21/growth-market";
import { ENTRY_CHAIN_KEY as KEY } from "@/lib/entry-chain-prev";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
export { prevChangeBeforeFill, storedWalkHead } from "@/lib/entry-chain-prev";

export const COOLDOWN_MS = 10 * 60 * 1000;
/** How often a chain-rebuilt record is re-checked (one `getSignaturesForAddress(limit 1)`): a newer signature may be a close + reopen at the same size. */
export const VERIFY_MS = 60 * 1000;
/** About 10 transactions a second: half the app's RPC proxy budget per browser (200 per 10 s), so the page's own reads keep working. */
export const PACE_TX_PER_S = 10;
/**
 * Council r10 round 2 review: a walk that ran out of budget ("incomplete") cannot finish later (the history only grows), so it is repeated at most
 * hourly; in between, a device record is checked each minute against the wallet's own transactions (lib/entry-chain.ts walletChangeCheck).
 */
export const INCOMPLETE_WALK_MS = 60 * 60 * 1000;

/**
 * Council r10 recheck D1: the trade book rebuilt from the walk (fills + the opening memo's funding base) is stored where every close surface
 * and the close toast already read it. This device's own book is kept only when its newest fill is the position's newest change on chain
 * (Council r10 round 2 MED: matching by size alone kept the OLD position's book after a same-size close + reopen on another device). A kept
 * book with no funding base gets the chain's base. A book the chain does not vouch for is replaced by the chain's, or removed when the chain
 * cannot rebuild one (the result is then unknown, never the old numbers).
 */
export function storeChainBook(t: Pick<SyncTarget, "wallet" | "slab" | "portfolio" | "qNow">, r: Pick<ChainEntryResult, "positionDeltas" | "startQ">): boolean {
  if (!r.positionDeltas || r.positionDeltas.length === 0 || r.startQ === undefined) return false;
  const newest = r.positionDeltas[r.positionDeltas.length - 1].sig;
  const book = bookFromDeltas(r.positionDeltas, r.startQ, t.qNow);
  const pk = t.portfolio.toBase58();
  const own = loadBook(t.wallet, t.slab, pk);
  if (own && own.q === t.qNow && own.lastSig === newest) {
    if (own.fundingBase !== null || !book || book.fundingBase === null) return false;
    saveBook(t.wallet, t.slab, pk, { ...own, fundingBase: book.fundingBase });
    return true;
  }
  if (!book) {
    if (!own) return false;
    saveBook(t.wallet, t.slab, pk, null);
    return true;
  }
  saveBook(t.wallet, t.slab, pk, book);
  return true;
}

interface Attempt {
  q: string;
  verdict: ChainEntryVerdict;
  ts: number;
  /** The portfolio's newest signature when a "chain" attempt read it: the record is vouched for only while it is still the newest. */
  topSig?: string;
  /** Council r10 recheck D6: the walk as it stood at `walkTop` (the current position's changes, oldest first), for an incremental rebuild. */
  walk?: { top: string; q: string; startQ: string; deltas: StoredDelta[] };
  /** When the last full walk ended "incomplete" (it read its whole budget): until INCOMPLETE_WALK_MS later only the cheap memo check runs. */
  walkTs?: number;
  /** The wallet's newest signature when the record was last checked against the wallet's own trades: unchanged = nothing new to read. */
  walletTop?: string;
  /** An unreadable walk left this device's own record unchecked (the wallet check failed too): the wallet check alone is repeated each minute. */
  ownOpen?: boolean;
}

function resumeOf(a: Attempt | null): ChainResume | null {
  const w = a?.walk;
  if (!w || typeof w.top !== "string" || !/^-?\d+$/.test(w.q) || !/^-?\d+$/.test(w.startQ)) return null;
  const deltas = loadDeltas(w.deltas, (k) => new PublicKey(k));
  return deltas && deltas.length > 0 ? { topSig: w.top, qAtTop: BigInt(w.q), startQ: BigInt(w.startQ), deltas } : null;
}

const memory = new Map<string, Attempt>();
const inflight = new Map<string, Promise<ChainEntryVerdict | "skipped">>();
let queue: Promise<unknown> = Promise.resolve();

function readAttempt(portfolio: string): Attempt | null {
  const m = memory.get(portfolio);
  if (m) return m;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY(portfolio));
    if (!raw) return null;
    const j = JSON.parse(raw) as Attempt;
    return typeof j.q === "string" && typeof j.verdict === "string" && typeof j.ts === "number" ? j : null;
  } catch {
    return null;
  }
}
function writeAttempt(portfolio: string, a: Attempt): void {
  memory.set(portfolio, a);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY(portfolio), JSON.stringify(a));
  } catch {
    /* storage unavailable: the memory map still bounds this session */
  }
}

/** Whether a rebuild is due for this portfolio at this size (pure; `now` injectable). */
export function rebuildDue(prior: Attempt | null, qNow: bigint, now: number): boolean {
  if (!prior || prior.q !== qNow.toString()) return true;
  if (prior.verdict === "no-position") return false;
  // A chain record is re-verified against the portfolio's newest signature, not trusted by size alone (N3).
  if (prior.verdict === "chain") return now - prior.ts >= VERIFY_MS;
  if (prior.verdict === "incomplete" && prior.walkTs !== undefined) return now - prior.ts >= VERIFY_MS;
  if (prior.verdict === "unreadable" && prior.ownOpen) return now - prior.ts >= VERIFY_MS;
  return now - prior.ts >= COOLDOWN_MS;
}

export interface SyncTarget {
  slab: string;
  idx: number;
  wallet: string;
  portfolio: PublicKey;
  wrapper: PublicKey;
  /** The signed ADL-effective size the chain holds now. */
  qNow: bigint;
  assetIndex?: number;
}

interface MarketFacts {
  baseFeeBps: bigint;
  /** The market account bytes (for the no-busy fee cap). */
  data: Uint8Array;
  /** A growth record may exist for the asset: a busy-side fee is possible. Fails toward true (undecodable counts as possible). */
  mayChargeBusy: boolean;
}
const factsCache = new Map<string, MarketFacts>();
const ctxCache = new Map<string, Uint8Array | null>();

/**
 * The market's own no-busy cap for a matcher context: `resolveTradeFeeBps` with no busy rate, from the market and matcher context as they are NOW
 * (history is not readable by standard RPC). If their inputs changed since a fill, the cap differs from what it signed and the Entry is unknown.
 */
async function noBusyCapFor(connection: Pick<Connection, "getAccountInfo">, facts: MarketFacts, assetIndex: number, ctx: PublicKey | null): Promise<NoBusyCap | null> {
  let ctxData: Uint8Array | null = null;
  if (ctx) {
    const k = ctx.toBase58();
    if (!ctxCache.has(k)) {
      try {
        const info = await connection.getAccountInfo(ctx, "confirmed");
        ctxCache.set(k, info ? new Uint8Array(info.data) : null);
      } catch {
        return null;
      }
    }
    ctxData = ctxCache.get(k) ?? null;
  }
  const r = resolveTradeFeeBps({ marketData: facts.data, matcherCtxData: ctxData, assetIndex });
  return r ? { feeBps: r.feeBps, maxFeeBps: r.maxFeeBps } : null;
}
async function marketFacts(connection: Pick<Connection, "getAccountInfo">, slab: string, assetIndex: number): Promise<MarketFacts | null> {
  const c = factsCache.get(slab);
  if (c) return c;
  try {
    const info = await connection.getAccountInfo(new PublicKey(slab), "confirmed");
    if (!info) return null;
    const data = new Uint8Array(info.data);
    const v = decodeMarketEngineView(data);
    if (!v) return null;
    const f = { baseFeeBps: v.tradeFeeBaseBps, data, mayChargeBusy: growthRecordPresence(data, assetIndex) !== "absent" };
    factsCache.set(slab, f);
    return f;
  } catch {
    return null;
  }
}

/** Runs one rebuild (queued, deduplicated, cooled down). Resolves to the verdict, or "skipped" when none was due. Never throws. */
export function syncChainEntry(connection: Connection, t: SyncTarget, now: () => number = Date.now): Promise<ChainEntryVerdict | "skipped"> {
  const pk = t.portfolio.toBase58();
  // Never for a flat position, an explicit "unknown" (owner decision 2), a trade in flight on this market, or when not due.
  if (t.qNow === 0n || markedWithoutSig(t) || chainSyncHeld(t.slab, now()) || !readDue(pk, t.qNow, now())) return Promise.resolve("skipped");
  const flightKey = `${pk}:${t.qNow}`;
  const running = inflight.get(flightKey);
  if (running) return running;
  const result = (async (): Promise<ChainEntryVerdict | "skipped"> => {
    // One rebuild at a time across every hook instance: the next waits for this one.
    queue = queue.then(() => run(connection, t, now)).catch(() => undefined);
    await queue;
    const a = memory.get(pk);
    return a && a.q === t.qNow.toString() ? a.verdict : "skipped";
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, result);
  return result;
}

/** A marker with no fill signature (written before it carried one) cannot be probed: it stands. A marker WITH one is probed (see `run`). */
function markedWithoutSig(t: SyncTarget): boolean {
  const m = getEntryUnknownMark(t.slab, t.idx, t.wallet, t.qNow);
  return m !== null && m.sig === null;
}

function readDue(pk: string, q: bigint, now: number): boolean {
  return rebuildDue(readAttempt(pk), q, now);
}

async function run(connection: Connection, t: SyncTarget, now: () => number): Promise<void> {
  const pk = t.portfolio.toBase58();
  if (!readDue(pk, t.qNow, now())) return; // another instance finished it while this one waited in the queue
  if (markedWithoutSig(t) || chainSyncHeld(t.slab, now())) return;
  const prior = readAttempt(pk);
  if (prior && prior.verdict === "chain" && prior.q === t.qNow.toString() && prior.topSig) {
    // A chain record is only vouched for while the portfolio's newest signature is the one it was read at.
    try {
      const latest = await connection.getSignaturesForAddress(t.portfolio, { limit: 1 }, "confirmed");
      if (latest.length > 0 && latest[0].signature === prior.topSig) {
        writeAttempt(pk, { ...prior, ts: now() });
        return;
      }
    } catch {
      writeAttempt(pk, { ...prior, ts: now() }); // cannot tell: leave the record, and back off a full verify window (an outage is not retried every poll)
      return;
    }
  }
  // The device record as it stood before the read: one that differs afterwards was written by this device meanwhile, and stands.
  const atStart = getSavedEntry(t.slab, t.idx, t.wallet);
  if (prior && prior.verdict === "incomplete" && prior.q === t.qNow.toString() && prior.walkTs !== undefined && now() - prior.walkTs < INCOMPLETE_WALK_MS) {
    // Only the wallet check, and only when the wallet signed something since the last one (one getSignaturesForAddress otherwise).
    const top = ownRecordSig(t, atStart) ? await walletTopSig(connection, t.wallet) : null;
    let settled = top !== null && top === prior.walletTop;
    if (ownRecordSig(t, atStart) && !settled) settled = await scanOwn(connection, t, atStart, now);
    // The wallet's top is remembered only once a check settled at it: a failed check is repeated next minute.
    const { walletTop: _drop, ...rest } = prior;
    writeAttempt(pk, { ...rest, ts: now(), ...(top && settled ? { walletTop: top } : {}) });
    return;
  }
  if (prior && prior.verdict === "unreadable" && prior.ownOpen && prior.q === t.qNow.toString() && prior.walkTs !== undefined && now() - prior.walkTs < COOLDOWN_MS) {
    // Live devnet: an unreadable walk (RPC 429s) must not leave an unchecked device record shown for the whole cooldown. Until the next full
    // walk, only the wallet check runs, each minute, until it settles.
    const settled = !ownRecordSig(t, atStart) || (await scanOwn(connection, t, atStart, now));
    writeAttempt(pk, { ...prior, ts: now(), ownOpen: !settled });
    return;
  }
  const facts = await marketFacts(connection, t.slab, t.assetIndex ?? 0);
  if (facts === null) {
    const settled = !ownRecordSig(t, atStart) || (await scanOwn(connection, t, atStart, now));
    writeAttempt(pk, { q: t.qNow.toString(), verdict: "unreadable", ts: now(), walkTs: now(), ...(settled ? {} : { ownOpen: true }), ...(prior?.walk ? { walk: prior.walk } : {}) });
    return;
  }
  // The walk is over the PORTFOLIO's own signature list only. (A wallet-first walk was tried and removed: a keeper-signed REDUCE is not on the
  // wallet's list, so the sizes can add up at a false flat point and give a wrong Entry.)
  const r = await entryFromChain(connection, t.wrapper, {
    market: new PublicKey(t.slab), portfolio: t.portfolio, assetIndex: t.assetIndex ?? 0, qNow: t.qNow, baseFeeBps: facts.baseFeeBps, mayChargeBusy: facts.mayChargeBusy,
    noBusyCap: (ctx) => noBusyCapFor(connection, facts, t.assetIndex ?? 0, ctx),
    concurrency: PACE_TX_PER_S, paceMs: 1000, resume: resumeOf(prior),
  });
  // The walk reached the position's start: keep it for the next (incremental) rebuild, and rebuild the trade book from it.
  const walk = r.positionDeltas && r.topSig && r.startQ !== undefined ? { top: r.topSig, q: t.qNow.toString(), startQ: r.startQ.toString(), deltas: storeDeltas(r.positionDeltas) } : undefined;
  // A trade landing on this device while the chain was read writes its own book and Entry: nothing from this walk is stored over them.
  if (chainSyncHeld(t.slab, now())) return;
  if (r.verdict === "chain" || r.verdict === "unexplained") storeChainBook(t, r);
  const mark = getEntryUnknownMark(t.slab, t.idx, t.wallet, t.qNow);
  if (mark) {
    const readToStart = (r.verdict === "chain" || r.verdict === "unexplained") && r.positionSigs !== undefined;
    if (readToStart && mark.sig && !r.positionSigs?.includes(mark.sig)) clearEntryUnknownMark(t.slab, t.idx, t.wallet);
    else {
      writeAttempt(pk, { q: t.qNow.toString(), verdict: "unexplained", ts: now(), ...(walk ? { walk } : {}) });
      return;
    }
  }
  let verdict = r.verdict;
  const stale = getSavedEntry(t.slab, t.idx, t.wallet);
  const readToStart = (r.verdict === "chain" || r.verdict === "unexplained") && r.positionSigs !== undefined && r.positionSigs.length > 0;
  // Council r10 round 2 MED: a record this device wrote is the position's only while its newest fill is still the position's newest change on
  // chain. Size alone cannot tell (a same-size close + reopen, or an add + reduce, on another device).
  const own = stale && !stale.chainSig && entryRecordCurrent(stale, t.qNow) ? stale : null;
  if (own && readToStart && own.lastSig !== null && own.lastSig === r.positionSigs?.[0]) {
    // Confirmed: it stands (it is this device's own, priced from the quote it signed), and is re-checked like a chain record.
    writeAttempt(pk, { q: t.qNow.toString(), verdict: "chain", ts: now(), ...(r.topSig ? { topSig: r.topSig } : {}), ...(walk ? { walk } : {}) });
    return;
  }
  // Written while the chain was read: it stands; the next check looks again.
  if (own && !sameRecord(own, atStart)) return;
  // Not confirmed by a walk that read to the start: an older record without a signature is replaced only by an exact chain Entry; one whose
  // newest fill is not the position's newest change is replaced, or removed when the chain cannot price it.
  const ownStale = own !== null && readToStart && own.lastSig !== null;
  if (r.verdict === "chain" && r.entry) {
    // The ticket may have written (or marked unknown) while the chain was read: whatever it wrote stands, the chain never overwrites it. A record
    // the chain itself wrote earlier (chainSig), or one the chain shows is out of date, is what it may replace.
    const meanwhile = getSavedEntry(t.slab, t.idx, t.wallet);
    if (isEntryMarkedUnknown(t.slab, t.idx, t.wallet, t.qNow) || chainSyncHeld(t.slab, now()) || !sameRecord(meanwhile, atStart)) {
      return; // no attempt recorded: nothing was learned that matters, and nothing was written
    }
    // A trade landing during a long read changes the size: this result is for the OLD size and is dropped.
    const nowQ = await readEffectivePositionQ(connection, t.portfolio, new PublicKey(t.slab));
    if (nowQ !== t.qNow) return;
    if (r.entry.entryPriceE6 !== null) {
      // The chain wins over this device's record: same key every surface reads (lib/entry-price.ts).
      saveEntryPrice(t.slab, t.idx, r.entry.entryPriceE6, getEntryLeverage(t.slab, t.idx, t.wallet) ?? undefined, t.wallet, r.entry.sizeQ, {
        bookedPriceE6: r.entry.bookedPriceE6,
        busyFeeAtoms: r.entry.busyFeeAtoms,
        ...(r.topSig ? { chainSig: r.topSig } : {}),
        ...(r.positionSigs?.[0] ? { lastSig: r.positionSigs[0] } : {}),
      });
    } else {
      verdict = "unexplained"; // read fully but a fill's price cannot be split from its fee: the cache stays as it was
    }
  }
  // A record the chain wrote earlier that the chain can no longer vouch for (newer signature, and now unknown / unexplained / mismatched) is
  // removed rather than shown as exact. An unreadable chain proves nothing, so it stays. The same for a device record the chain shows is out
  // of date and cannot replace.
  if (verdict !== "chain" && verdict !== "unreadable" && stale?.chainSig) clearEntryPrice(t.slab, t.idx, t.wallet);
  else if (verdict !== "chain" && ownStale) clearEntryPrice(t.slab, t.idx, t.wallet);
  // The walk did not reach the position's start (a long hold, an unreadable or unexplainable transaction): the wallet's own transactions since
  // this device's fill still show any trade that changed the position, however long ago.
  let walletTop = !readToStart && ownRecordSig(t, atStart) ? await walletTopSig(connection, t.wallet) : null;
  const ownSettled = readToStart || (await scanOwn(connection, t, atStart, now));
  if (!ownSettled) walletTop = null;
  const ownOpen = verdict === "unreadable" && !ownSettled && ownRecordSig(t, getSavedEntry(t.slab, t.idx, t.wallet)) !== null;
  writeAttempt(pk, { q: t.qNow.toString(), verdict, ts: now(), ...(verdict === "incomplete" || ownOpen ? { walkTs: now() } : {}), ...(ownOpen ? { ownOpen } : {}), ...(walletTop ? { walletTop } : {}), ...(verdict === "chain" && r.topSig ? { topSig: r.topSig } : {}), ...(walk ? { walk } : prior?.walk && verdict === "unreadable" ? { walk: prior.walk } : {}) });
}

/**
 * Council r10 round 2 review: when the walk cannot reach the position's start, a device record (Entry, or the trade book) is checked against
 * the WALLET's own transactions since its newest fill (lib/entry-chain.ts walletChangeCheck): every trade from any client is wallet-signed.
 * One that changed the position means the record describes an earlier one; a Position NFT / ownership move in between means it cannot be
 * vouched for. Either way it is removed (unknown), never shown. Nothing is removed when it cannot be told, or when a trade on this device is in
 * flight / was written meanwhile. Returns true when the check settled (so the wallet's top may be remembered), false to look again.
 */
/** The newest fill of this device's own record for the position (its Entry, else its trade book), or null when it has none to check. */
function ownRecordSig(t: SyncTarget, atStart: SavedEntry | null): string | null {
  // Council r3 Risk: an Entry the chain wrote earlier (chainSig) is checked the same way: it names its newest fill too.
  const own = atStart && entryRecordCurrent(atStart, t.qNow) ? atStart : null;
  const book = loadBook(t.wallet, t.slab, t.portfolio.toBase58());
  return own?.lastSig ?? (book && book.q === t.qNow ? book.lastSig ?? null : null);
}

async function scanOwn(connection: Connection, t: SyncTarget, atStart: SavedEntry | null, now: () => number): Promise<boolean> {
  const pk = t.portfolio.toBase58();
  const own = atStart && entryRecordCurrent(atStart, t.qNow) ? atStart : null;
  const book = loadBook(t.wallet, t.slab, pk);
  const ownBook = book && book.q === t.qNow ? book : null;
  const sig = ownRecordSig(t, atStart);
  if (!sig) return true;
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(t.wallet);
  } catch {
    return false;
  }
  const m = await walletChangeCheck(connection, t.wrapper, { wallet, market: new PublicKey(t.slab), portfolio: t.portfolio, assetIndex: t.assetIndex ?? 0, recordSig: sig, paceMs: 1000 / PACE_TX_PER_S * 10, nftProgram: PERCOLATOR_NFT_PROGRAM_ID });
  if (m.kind === "current") return true;
  if (m.kind !== "changed" && m.kind !== "foreign") return false; // could not tell: checked again next minute
  if (chainSyncHeld(t.slab, now()) || !sameRecord(getSavedEntry(t.slab, t.idx, t.wallet), atStart)) return false;
  if (own) clearEntryPrice(t.slab, t.idx, t.wallet);
  if (ownBook && loadBook(t.wallet, t.slab, pk)?.lastSig === ownBook.lastSig) saveBook(t.wallet, t.slab, pk, null);
  return true;
}

async function walletTopSig(connection: Pick<Connection, "getSignaturesForAddress">, wallet: string): Promise<string | null> {
  try {
    const r = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 1 }, "confirmed");
    return r[0]?.signature ?? null;
  } catch {
    return null;
  }
}

function sameRecord(a: SavedEntry | null, b: SavedEntry | null): boolean {
  if (!a || !b) return a === b;
  return a.savedAt === b.savedAt && a.entryPriceE6 === b.entryPriceE6 && a.sizeQ === b.sizeQ && a.lastSig === b.lastSig && a.chainSig === b.chainSig;
}

export function __resetEntryChainSyncForTests(): void {
  memory.clear();
  inflight.clear();
  factsCache.clear();
  ctxCache.clear();
  __resetChainSyncHoldsForTests();
  queue = Promise.resolve();
}

/** The slice of a portfolio row the trigger reads. */
export interface SyncCandidate {
  slabAddress: string;
  idx: number;
  adlKnown: boolean;
  effectiveSize: bigint;
  nftWrapped?: boolean;
  portfolioPk: PublicKey | null;
  entryPriceSource: string;
  account?: { positionSize: bigint } | null;
}

/**
 * Whether `usePortfolio` should start a rebuild for a row: an open, ADL-readable, self-owned position this device has no current entry for.
 * Never for a position carrying the explicit "unknown" marker (owner decision 2) or with a trade in flight on its market.
 */
export function shouldSyncPosition(p: SyncCandidate, wallet: string, now: number = Date.now()): boolean {
  if ((p.account?.positionSize ?? 0n) === 0n || !p.adlKnown || p.effectiveSize === 0n || p.nftWrapped || !p.portfolioPk) return false;
  if (p.entryPriceSource === "server") return false;
  // Every cached entry is re-checked against the chain, the device's own included (Council r10 round 2 MED: a same-size close + reopen on
  // another device leaves the size equal). A check whose top signature is unchanged costs one getSignaturesForAddress (rebuildDue / run).
  // A marker with a fill signature is probed by the walk (it may belong to a position that is gone); one without stands.
  const mark = getEntryUnknownMark(p.slabAddress, p.idx, wallet, p.effectiveSize);
  if ((mark !== null && mark.sig === null) || chainSyncHeld(p.slabAddress, now)) return false;
  return true;
}
