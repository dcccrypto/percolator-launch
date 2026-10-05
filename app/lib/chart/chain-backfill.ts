/**
 * One-time on-chain backfill of MARK candles.
 *
 * Every mark the keeper pushed is a PushAuthMark instruction (wrapper tag 63) in a transaction the
 * keeper signed: tag u8 | assetIndex u16 | marketId u64 | nowSlot u64 | markE6 u64 | observationSequence u64
 * (35 bytes), accounts [oracleAuthority(signer), market]. Several markets share one transaction.
 * This rebuilds the Mark candles of each market from those instructions, from the market's launch up to
 * the moment the live candle store started, and writes them with src='chain'.
 *
 * Properties:
 *  - read-only against the chain; rate-limited (see chain-rpc.ts), because the key is the live keeper's;
 *  - idempotent: chain rows replace a previous chain run outright and never touch live rows except the
 *    one bucket that straddles the cutover, where chain and live merge (see candle-store.ts);
 *  - resumable: after every chunk the cursor and the forming candles are saved, so a restart continues
 *    exactly where it stopped and produces identical rows;
 *  - bounded: only candles inside each resolution's retention window are written (older ones would be
 *    pruned within the hour anyway).
 *
 * The raw oracle price is NOT in the instruction, so the oracle series is not touched here (Gecko
 * covers it).
 */
import bs58 from "bs58";
import { CandleBook } from "./candles";
import { RETENTION_DAYS, type CandleRow, type CandleStore } from "./candle-store";
import { CANDLE_RES_MINUTES, type Candle, type CandleResMinutes } from "./perp-types";

export const PUSH_AUTH_MARK_TAG = 63;
export const PUSH_AUTH_MARK_LEN = 35;

export interface DecodedPush {
  assetIndex: number;
  marketId: bigint;
  nowSlot: bigint;
  markE6: bigint;
  observationSequence: bigint;
}

export function decodePushAuthMark(data: Uint8Array): DecodedPush | null {
  if (data.length !== PUSH_AUTH_MARK_LEN || data[0] !== PUSH_AUTH_MARK_TAG) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const markE6 = dv.getBigUint64(19, true);
  if (markE6 <= 0n) return null;
  return {
    assetIndex: dv.getUint16(1, true),
    marketId: dv.getBigUint64(3, true),
    nowSlot: dv.getBigUint64(11, true),
    markE6,
    observationSequence: dv.getBigUint64(27, true),
  };
}

/** The slice of `getTransaction` (encoding json, maxSupportedTransactionVersion 1: legacy, v0 and v1) this module reads. */
export interface RpcTx {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; loadedAddresses?: { writable?: string[]; readonly?: string[] } } | null;
  transaction: {
    message: {
      accountKeys: string[];
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    };
  };
}

export interface ChainPush extends DecodedPush {
  slab: string;
  slot: number;
  blockTime: number;
}

/** Every successful PushAuthMark to `programId` in a transaction, with the market it targeted. */
export function extractPushes(tx: RpcTx, programId: string): ChainPush[] {
  if (!tx.meta || tx.meta.err !== null || tx.blockTime === null || tx.blockTime === undefined) return [];
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const out: ChainPush[] = [];
  for (const ix of m.instructions) {
    if (keys[ix.programIdIndex] !== programId || ix.accounts.length < 2) continue;
    let bytes: Uint8Array;
    try { bytes = bs58.decode(ix.data); } catch { continue; }
    const d = decodePushAuthMark(bytes);
    if (!d) continue;
    const slab = keys[ix.accounts[1]];
    if (!slab) continue;
    out.push({ ...d, slab, slot: tx.slot, blockTime: tx.blockTime });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC + progress seams
// ---------------------------------------------------------------------------

export interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown }

export interface ChainRpc {
  /** Newest first, at most `limit`, strictly older than `before` when given. */
  getSignatures(address: string, before: string | undefined, limit: number): Promise<SigInfo[]>;
  /** One entry per signature, null when the node no longer has it. */
  getTransactions(signatures: readonly string[]): Promise<Array<RpcTx | null>>;
}

export type BookState = Record<string, Partial<Record<CandleResMinutes, Candle>>>;

export interface BackfillProgress {
  cursorSlot: number;
  cursorSig: string | null;
  processed: number;
  pushes: number;
  state: BookState;
  done: boolean;
}

export interface ProgressStore {
  load(): Promise<BackfillProgress | null>;
  save(p: BackfillProgress): Promise<void>;
}

export class MemoryProgressStore implements ProgressStore {
  value: BackfillProgress | null = null;
  async load() { return this.value ? structuredClone(this.value) : null; }
  async save(p: BackfillProgress) { this.value = structuredClone(p); }
}

export function createPgProgressStore(
  sql: { unsafe(q: string, p?: unknown[]): Promise<Array<Record<string, unknown>>> },
  id = "mark-chain",
): ProgressStore {
  return {
    async load() {
      const r = (await sql.unsafe(`SELECT cursor_slot, cursor_sig, processed, pushes, state, done FROM chart_chain_backfill WHERE id=$1`, [id]))[0];
      if (!r) return null;
      return {
        cursorSlot: Number(r.cursor_slot), cursorSig: (r.cursor_sig as string | null) ?? null,
        processed: Number(r.processed), pushes: Number(r.pushes),
        state: (typeof r.state === "string" ? JSON.parse(r.state) : r.state) as BookState, done: r.done === true,
      };
    },
    async save(p) {
      await sql.unsafe(
        `INSERT INTO chart_chain_backfill (id, cursor_slot, cursor_sig, processed, pushes, state, done, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, now())
         ON CONFLICT (id) DO UPDATE SET cursor_slot=excluded.cursor_slot, cursor_sig=excluded.cursor_sig,
           processed=excluded.processed, pushes=excluded.pushes, state=excluded.state, done=excluded.done, updated_at=now()`,
        [id, p.cursorSlot, p.cursorSig, p.processed, p.pushes, JSON.stringify(p.state), p.done],
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

export interface BackfillOptions {
  /** Market slabs to rebuild (the markets we chart). */
  slabs: readonly string[];
  /** The keeper wallet: every PushAuthMark tx it signed is listed from here. */
  authority: string;
  /** The wrapper program that owns the markets. */
  programId: string;
  /** Ignore transactions older than this (unix s). Default: no lower bound (the market's launch). */
  sinceSec?: number;
  /** Signatures fetched per chunk (and the progress-save interval). */
  chunk?: number;
  /** Start over instead of resuming (the output is identical either way). */
  restart?: boolean;
  /**
   * Fetch only transactions whose block time falls in the first N seconds of each minute (1..59).
   * Cuts RPC cost to about N/60 of the full run; pushes are spread evenly across every cycle, so every
   * market is still sampled every minute, but 1m highs/lows then reflect only that part of the minute
   * (5m and coarser are effectively unaffected). Default: every transaction (full fidelity).
   */
  sampleSeconds?: number;
  /** Plan only: list and count, fetch nothing, write nothing. */
  dryRun?: boolean;
  /** Stop after this many chunks (testing / time-boxing); progress is saved so a later run continues. */
  maxChunks?: number;
}

export interface BackfillDeps {
  rpc: ChainRpc;
  store: CandleStore;
  progress: ProgressStore;
  now?: () => number;
  log?: (line: string) => void;
}

export interface BackfillSummary {
  status: "done" | "partial" | "already-done" | "dry-run";
  listed: number;
  fetched: number;
  pushes: number;
  rowsWritten: number;
  skippedLive: number;
  chunks: number;
}

const PAGE = 1000;

/** Open time below which a resolution's candles are already past retention (not worth writing). */
function retentionFloor(res: CandleResMinutes, nowSec: number): number {
  const days = RETENTION_DAYS[res];
  return days === null ? 0 : nowSec - days * 86_400;
}

export async function runChainBackfill(opts: BackfillOptions, deps: BackfillDeps): Promise<BackfillSummary> {
  const log = deps.log ?? (() => {});
  const nowSec = Math.floor((deps.now ?? Date.now)() / 1000);
  const slabSet = new Set(opts.slabs);
  const chunkSize = opts.chunk ?? 100;
  const sum: BackfillSummary = { status: "done", listed: 0, fetched: 0, pushes: 0, rowsWritten: 0, skippedLive: 0, chunks: 0 };

  // Per-slab cutover: the first live mark candle. Nothing at or after it is rebuilt from chain
  // (the live feed owns it); the straddling bucket merges in the store.
  const cutoff = new Map<string, number>();
  for (const s of slabSet) cutoff.set(s, (await deps.store.firstLiveT(s, "mark")) ?? Number.POSITIVE_INFINITY);
  const maxCutoff = Math.max(...cutoff.values());

  let prog = opts.restart ? null : await deps.progress.load();
  if (prog?.done) {
    log("already complete (use restart to rebuild)");
    return { ...sum, status: "already-done" };
  }

  // 1) List the keeper's signatures newest -> oldest (cheap: 1000 per call), keep successful ones
  //    older than the latest cutover, stop at sinceSec. Then work oldest -> newest.
  const sigs: SigInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await deps.rpc.getSignatures(opts.authority, before, PAGE);
    if (page.length === 0) break;
    let reachedFloor = false;
    for (const s of page) {
      if (s.blockTime !== null && opts.sinceSec !== undefined && s.blockTime < opts.sinceSec) { reachedFloor = true; continue; }
      if (s.err) continue;
      if (s.blockTime !== null && Number.isFinite(maxCutoff) && s.blockTime >= maxCutoff) continue;
      if (opts.sampleSeconds !== undefined && s.blockTime !== null && s.blockTime % 60 >= opts.sampleSeconds) continue;
      sigs.push(s);
    }
    before = page[page.length - 1].signature;
    // Only an EMPTY page ends the listing: some providers (Helius) return short pages mid-history.
    if (reachedFloor) break;
  }
  sigs.reverse();
  sum.listed = sigs.length;
  log(`listed ${sigs.length} candidate transactions`);
  if (opts.dryRun) return { ...sum, status: "dry-run" };

  // 2) Resume point.
  let start = 0;
  if (prog && prog.cursorSig) {
    const i = sigs.findIndex((s) => s.signature === prog!.cursorSig);
    start = i >= 0 ? i + 1 : sigs.findIndex((s) => s.slot > prog!.cursorSlot);
    if (start < 0) start = sigs.length;
  }
  const books = new Map<string, CandleBook>();
  for (const [slab, byRes] of Object.entries(prog?.state ?? {})) books.set(slab, new CandleBook(byRes));
  const lastSlot = new Map<string, number>();
  let processed = prog?.processed ?? 0;
  let pushes = prog?.pushes ?? 0;

  const snapshot = (): BookState => {
    const out: BookState = {};
    for (const [slab, b] of books) {
      const o: Partial<Record<CandleResMinutes, Candle>> = {};
      for (const r of CANDLE_RES_MINUTES) { const c = b.get(r); if (c) o[r] = c; }
      out[slab] = o;
    }
    return out;
  };
  const keep = (res: CandleResMinutes, t: number) => t >= retentionFloor(res, nowSec);
  const toRow = (slab: string, res: CandleResMinutes, candle: Candle): CandleRow => ({ slab, series: "mark", res, candle, src: "chain" });

  // 3) Chunked fetch -> fold -> write -> save.
  let chunks = 0;
  for (let i = start; i < sigs.length; i += chunkSize) {
    if (opts.maxChunks !== undefined && chunks >= opts.maxChunks) { sum.status = "partial"; break; }
    const slice = sigs.slice(i, i + chunkSize);
    const txs = await deps.rpc.getTransactions(slice.map((s) => s.signature));
    sum.fetched += slice.length;
    const rows: CandleRow[] = [];
    const ordered = slice
      .map((s, k) => ({ s, tx: txs[k] }))
      .filter((x): x is { s: SigInfo; tx: RpcTx } => x.tx !== null)
      .sort((a, b) => a.tx.slot - b.tx.slot);
    for (const { tx } of ordered) {
      for (const p of extractPushes(tx, opts.programId)) {
        if (!slabSet.has(p.slab) || p.assetIndex !== 0) continue;
        if (p.blockTime >= (cutoff.get(p.slab) as number)) { sum.skippedLive++; continue; }
        if (p.slot < (lastSlot.get(p.slab) ?? 0)) continue; // never let a late tx rewrite earlier bars
        lastSlot.set(p.slab, p.slot);
        let book = books.get(p.slab);
        if (!book) { book = new CandleBook(); books.set(p.slab, book); }
        pushes++;
        for (const { res, closed } of book.apply(Number(p.markE6) / 1e6, p.blockTime * 1000)) {
          if (closed && keep(res, closed.t)) rows.push(toRow(p.slab, res, closed));
        }
      }
    }
    processed += slice.length;
    const last = slice[slice.length - 1];
    if (rows.length) await deps.store.upsert(rows);
    sum.rowsWritten += rows.length;
    prog = { cursorSlot: last.slot, cursorSig: last.signature, processed, pushes, state: snapshot(), done: false };
    await deps.progress.save(prog);
    chunks++;
    sum.chunks = chunks;
    if (chunks % 10 === 0) log(`chunk ${chunks}: ${processed}/${sigs.length} txs, ${pushes} pushes, ${sum.rowsWritten} candles`);
  }
  if (sum.status === "partial") { sum.pushes = pushes; return sum; }

  // 4) Flush the forming candles (the last, partial bucket before each cutover).
  const tail: CandleRow[] = [];
  for (const [slab, b] of books) for (const r of CANDLE_RES_MINUTES) {
    const c = b.get(r);
    if (c && keep(r, c.t)) tail.push(toRow(slab, r, c));
  }
  if (tail.length) await deps.store.upsert(tail);
  sum.rowsWritten += tail.length;
  sum.pushes = pushes;
  const lastSig = sigs[sigs.length - 1];
  await deps.progress.save({
    cursorSlot: lastSig?.slot ?? prog?.cursorSlot ?? 0, cursorSig: lastSig?.signature ?? prog?.cursorSig ?? null,
    processed, pushes, state: snapshot(), done: true,
  });
  return sum;
}
