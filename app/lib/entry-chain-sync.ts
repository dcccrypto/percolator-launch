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
import { getEntryLeverage, saveEntryPrice } from "@/lib/entry-price";

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

const feeCache = new Map<string, bigint>();
async function baseFeeBps(connection: Pick<Connection, "getAccountInfo">, slab: string): Promise<bigint | null> {
  const c = feeCache.get(slab);
  if (c !== undefined) return c;
  try {
    const info = await connection.getAccountInfo(new PublicKey(slab), "confirmed");
    const v = info ? decodeMarketEngineView(new Uint8Array(info.data)) : null;
    if (!v) return null;
    feeCache.set(slab, v.tradeFeeBaseBps);
    return v.tradeFeeBaseBps;
  } catch {
    return null;
  }
}

/** Runs one rebuild (queued, deduplicated, cooled down). Resolves to the verdict, or "skipped" when none was due. Never throws. */
export function syncChainEntry(connection: Connection, t: SyncTarget, now: () => number = Date.now): Promise<ChainEntryVerdict | "skipped"> {
  const pk = t.portfolio.toBase58();
  if (t.qNow === 0n || !readDue(pk, t.qNow, now())) return Promise.resolve("skipped");
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
  const fee = await baseFeeBps(connection, t.slab);
  if (fee === null) {
    writeAttempt(pk, { q: t.qNow.toString(), verdict: "unreadable", ts: now() });
    return;
  }
  const r = await entryFromChain(connection, t.wrapper, { market: new PublicKey(t.slab), portfolio: t.portfolio, assetIndex: t.assetIndex ?? 0, qNow: t.qNow, baseFeeBps: fee });
  let verdict = r.verdict;
  if (r.verdict === "chain" && r.entry) {
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
  feeCache.clear();
  queue = Promise.resolve();
}
