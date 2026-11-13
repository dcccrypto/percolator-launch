/**
 * r10 owner decision 6: puts a chain-derived Entry (lib/entry-chain.ts) into the entry cache every surface already reads, so no surface changes.
 *
 * When it runs: only for an open position this device has NO CURRENT entry for (no record, a record for another size, a back-solved estimate):
 * a record this device just wrote is the same numbers by construction and costs no RPC. Which source wins: a chain-derived entry replaces the
 * device record; when the chain history cannot be read completely the device cache is left exactly as it was (nothing is written, nothing guessed).
 *
 * Bounds (devnet RPC is shared): one rebuild at a time per page (a module-level queue), at most `maxTx` transactions each (lib/entry-chain.ts),
 * and a cooldown per portfolio and size: a completed rebuild is not repeated for that size; an unreadable / incomplete one waits
 * `COOLDOWN_MS` (10 min) unless the size changed. The memory map and the storage record both carry it, so a reload does not retry at once.
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { entryFromChain, type ChainEntryVerdict, type NoBusyCap } from "@/lib/entry-chain";
import { resolveTradeFeeBps } from "@/lib/limits/trade-fee-resolve";
import { clearEntryPrice, clearEntryUnknownMark, entryRecordCurrent, getEntryLeverage, getEntryUnknownMark, getSavedEntry, isEntryMarkedUnknown, saveEntryPrice } from "@/lib/entry-price";
import { readEffectivePositionQ } from "@/lib/position-change";
import { __resetChainSyncHoldsForTests, chainSyncHeld, holdChainSync } from "@/lib/entry-chain-hold";
export { chainSyncHeld, holdChainSync };
import { growthRecordPresence } from "@/lib/v21/growth-market";

export const COOLDOWN_MS = 10 * 60 * 1000;
/** How often a chain-rebuilt record is re-checked (one `getSignaturesForAddress(limit 1)`): a newer signature may be a close + reopen at the same size. */
export const VERIFY_MS = 60 * 1000;
const KEY = (portfolio: string) => `perc:entrychain:v1:${portfolio}`;

interface Attempt {
  q: string;
  verdict: ChainEntryVerdict;
  ts: number;
  /** The portfolio's newest signature when a "chain" attempt read it: the record is vouched for only while it is still the newest. */
  topSig?: string;
  /** Whose newest signature `topSig` is: the trader's wallet (its walk found the position) or the portfolio. */
  src?: "wallet" | "portfolio";
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
    // A chain record is only vouched for while the newest signature of the address it was read from (wallet or portfolio) is the one it was read at.
    try {
      const latest = await connection.getSignaturesForAddress(prior.src === "wallet" ? new PublicKey(t.wallet) : t.portfolio, { limit: 1 }, "confirmed");
      if (latest.length > 0 && latest[0].signature === prior.topSig) {
        writeAttempt(pk, { ...prior, ts: now() });
        return;
      }
    } catch {
      writeAttempt(pk, { ...prior, ts: now() }); // cannot tell: leave the record, and back off a full verify window (an outage is not retried every poll)
      return;
    }
  }
  const facts = await marketFacts(connection, t.slab, t.assetIndex ?? 0);
  if (facts === null) {
    writeAttempt(pk, { q: t.qNow.toString(), verdict: "unreadable", ts: now() });
    return;
  }
  const base = { market: new PublicKey(t.slab), portfolio: t.portfolio, assetIndex: t.assetIndex ?? 0, qNow: t.qNow, baseFeeBps: facts.baseFeeBps, mayChargeBusy: facts.mayChargeBusy, noBusyCap: (ctx: PublicKey | null) => noBusyCapFor(connection, facts, t.assetIndex ?? 0, ctx) };
  // The trader's wallet signs every trade but not the keeper's cranks, which fill a trader portfolio's own list: walk the wallet first so the
  // budget goes to real fills. When that walk cannot settle (unreadable / incomplete / sizes do not add up, e.g. a keeper-signed liquidation is not
  // on the wallet's list), the portfolio walk decides. A wallet result that is "chain" has to add up to the chain's size exactly, like any other.
  let src: "wallet" | "portfolio" = "wallet";
  let walletKey: PublicKey | null = null;
  try {
    walletKey = new PublicKey(t.wallet);
  } catch {
    walletKey = null;
  }
  let r = walletKey ? await entryFromChain(connection, t.wrapper, { ...base, walkAddress: walletKey }) : null;
  if (!r || (r.verdict !== "chain" && r.verdict !== "unexplained")) {
    src = "portfolio";
    r = await entryFromChain(connection, t.wrapper, base);
  }
  // An "unknown" marker stands for as long as the position it was written for does. The walk can tell: when that fill is not part of the current
  // position any more (closed and reopened elsewhere, even at the same size), the marker is retired and the rebuild goes on. Otherwise nothing is
  // ever saved over it.
  const mark = getEntryUnknownMark(t.slab, t.idx, t.wallet, t.qNow);
  if (mark) {
    const readToStart = (r.verdict === "chain" || r.verdict === "unexplained") && r.positionSigs !== undefined;
    if (readToStart && mark.sig && !r.positionSigs?.includes(mark.sig)) clearEntryUnknownMark(t.slab, t.idx, t.wallet);
    else {
      writeAttempt(pk, { q: t.qNow.toString(), verdict: "unexplained", ts: now() });
      return;
    }
  }
  let verdict = r.verdict;
  const stale = getSavedEntry(t.slab, t.idx, t.wallet);
  if (r.verdict === "chain" && r.entry) {
    // The ticket may have written (or marked unknown) while the chain was read: whatever it wrote stands, the chain never overwrites it. A record
    // the chain itself wrote earlier (chainSig) is the one thing it may replace.
    const meanwhile = getSavedEntry(t.slab, t.idx, t.wallet);
    if (isEntryMarkedUnknown(t.slab, t.idx, t.wallet, t.qNow) || chainSyncHeld(t.slab, now()) || (meanwhile && entryRecordCurrent(meanwhile, t.qNow) && !meanwhile.chainSig)) {
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
      });
    } else {
      verdict = "unexplained"; // read fully but a fill's price cannot be split from its fee: the cache stays as it was
    }
  }
  // A record the chain wrote earlier that the chain can no longer vouch for (newer signature, and now unknown / unexplained / mismatched) is
  // removed rather than shown as exact. An unreadable chain proves nothing, so it stays.
  if (verdict !== "chain" && verdict !== "unreadable" && stale?.chainSig) clearEntryPrice(t.slab, t.idx, t.wallet);
  writeAttempt(pk, { q: t.qNow.toString(), verdict, ts: now(), ...(verdict === "chain" && r.topSig ? { topSig: r.topSig, src } : {}) });
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
  // A device-written entry is current by construction. A chain-rebuilt one is re-verified (newer signature = maybe a same-size reopen).
  if (p.entryPriceSource === "cache" && !getSavedEntry(p.slabAddress, p.idx, wallet)?.chainSig) return false;
  // A marker with a fill signature is probed by the walk (it may belong to a position that is gone); one without stands.
  const mark = getEntryUnknownMark(p.slabAddress, p.idx, wallet, p.effectiveSize);
  if ((mark !== null && mark.sig === null) || chainSyncHeld(p.slabAddress, now)) return false;
  return true;
}
