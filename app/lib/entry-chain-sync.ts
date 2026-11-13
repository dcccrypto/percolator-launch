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
import { entryFromChain, type ChainEntryVerdict } from "@/lib/entry-chain";
import { entryRecordCurrent, getEntryLeverage, getSavedEntry, isEntryMarkedUnknown, saveEntryPrice } from "@/lib/entry-price";
import { growthRecordPresence } from "@/lib/v21/growth-market";

export const COOLDOWN_MS = 10 * 60 * 1000;
const KEY = (portfolio: string) => `perc:entrychain:v1:${portfolio}`;

interface Attempt {
  q: string;
  verdict: ChainEntryVerdict;
  ts: number;
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
  if (prior.verdict === "chain" || prior.verdict === "no-position") return false;
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

/**
 * r10: a trade on this device is in flight (or just landed) on `slab`: the ticket / close hook is about to write the position's entry itself,
 * so no chain rebuild may start or save meanwhile. Time-boxed so a stuck wallet prompt cannot block a rebuild forever.
 */
const holds = new Map<string, number>();
export function holdChainSync(slab: string, ms: number, now: number = Date.now()): void {
  holds.set(slab, Math.max(holds.get(slab) ?? 0, now + ms));
}
export function chainSyncHeld(slab: string, now: number = Date.now()): boolean {
  return (holds.get(slab) ?? 0) > now;
}

interface MarketFacts {
  baseFeeBps: bigint;
  /** A growth record may exist for the asset: a busy-side fee is possible. Fails toward true (undecodable counts as possible). */
  mayChargeBusy: boolean;
}
const factsCache = new Map<string, MarketFacts>();
async function marketFacts(connection: Pick<Connection, "getAccountInfo">, slab: string, assetIndex: number): Promise<MarketFacts | null> {
  const c = factsCache.get(slab);
  if (c) return c;
  try {
    const info = await connection.getAccountInfo(new PublicKey(slab), "confirmed");
    if (!info) return null;
    const data = new Uint8Array(info.data);
    const v = decodeMarketEngineView(data);
    if (!v) return null;
    const f = { baseFeeBps: v.tradeFeeBaseBps, mayChargeBusy: growthRecordPresence(data, assetIndex) !== "absent" };
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
  if (t.qNow === 0n || isEntryMarkedUnknown(t.slab, t.idx, t.wallet) || chainSyncHeld(t.slab, now()) || !readDue(pk, t.qNow, now())) return Promise.resolve("skipped");
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

function readDue(pk: string, q: bigint, now: number): boolean {
  return rebuildDue(readAttempt(pk), q, now);
}

async function run(connection: Connection, t: SyncTarget, now: () => number): Promise<void> {
  const pk = t.portfolio.toBase58();
  if (!readDue(pk, t.qNow, now())) return; // another instance finished it while this one waited in the queue
  if (isEntryMarkedUnknown(t.slab, t.idx, t.wallet) || chainSyncHeld(t.slab, now())) return;
  const facts = await marketFacts(connection, t.slab, t.assetIndex ?? 0);
  if (facts === null) {
    writeAttempt(pk, { q: t.qNow.toString(), verdict: "unreadable", ts: now() });
    return;
  }
  const r = await entryFromChain(connection, t.wrapper, { market: new PublicKey(t.slab), portfolio: t.portfolio, assetIndex: t.assetIndex ?? 0, qNow: t.qNow, baseFeeBps: facts.baseFeeBps, mayChargeBusy: facts.mayChargeBusy });
  let verdict = r.verdict;
  if (r.verdict === "chain" && r.entry) {
    // The ticket may have written (or marked unknown) while the chain was read: whatever it wrote stands, the chain never overwrites it.
    const meanwhile = getSavedEntry(t.slab, t.idx, t.wallet);
    if (isEntryMarkedUnknown(t.slab, t.idx, t.wallet) || chainSyncHeld(t.slab, now()) || (meanwhile && entryRecordCurrent(meanwhile, t.qNow))) {
      return; // no attempt recorded: nothing was learned that matters, and nothing was written
    }
    if (r.entry.entryPriceE6 !== null) {
      // The chain wins over this device's record: same key every surface reads (lib/entry-price.ts).
      saveEntryPrice(t.slab, t.idx, r.entry.entryPriceE6, getEntryLeverage(t.slab, t.idx, t.wallet) ?? undefined, t.wallet, r.entry.sizeQ, {
        bookedPriceE6: r.entry.bookedPriceE6,
        busyFeeAtoms: r.entry.busyFeeAtoms,
      });
    } else {
      verdict = "unexplained"; // read fully but a fill's price cannot be split from its fee: the cache stays as it was
    }
  }
  writeAttempt(pk, { q: t.qNow.toString(), verdict, ts: now() });
}

export function __resetEntryChainSyncForTests(): void {
  memory.clear();
  inflight.clear();
  factsCache.clear();
  holds.clear();
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
  if (p.entryPriceSource === "cache" || p.entryPriceSource === "server") return false;
  if (isEntryMarkedUnknown(p.slabAddress, p.idx, wallet) || chainSyncHeld(p.slabAddress, now)) return false;
  return true;
}
