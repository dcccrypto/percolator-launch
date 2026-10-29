/**
 * D2 gate (v22 deep memo 2026-10-29): the wallet screen for positions reduced WITHOUT the trader's own order (liquidation, ADL wind-down,
 * eviction, the LP stop, ...). Rows come from the indexer's `v22_events` (kind `reduce_event`, written by percolator-indexer #243 from the
 * wrapper's REDUCE log events); `actor` is the PORTFOLIO that was reduced. Words come only from `reduceNoticeCopy`: a reason this app does
 * not know is dropped, never shown with made-up text.
 */
import { PublicKey } from "@solana/web3.js";
import { REDUCE_REASON_V22 } from "./sdk/v22-fill-events";
import { reduceNoticeCopy } from "./reduce-copy";

/** At most this many portfolios per request (a wallet holds one per market). */
export const REDUCE_EVENTS_MAX_PORTFOLIOS = 25;
/** Newest events returned. */
export const REDUCE_EVENTS_LIMIT = 50;

export interface ReduceEventView {
  signature: string;
  market: string | null;
  portfolio: string;
  /** ISO time, or null when the indexer had no block time. */
  at: string | null;
  slot: number | null;
  reason: number;
  /** The W1 liquidity stop (reason 8). */
  lpStop: boolean;
  title: string;
  body: string;
  /** Size removed, in position units (absolute, decimal string). */
  reducedQ: string | null;
  priceE6: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : null);

/** One `v22_events` row -> a screen row, or null (not a reduce event, unknown reason, malformed). */
export function toReduceEventView(row: Record<string, unknown>): ReduceEventView | null {
  if (row.kind !== "reduce_event") return null;
  const signature = str(row.signature);
  const portfolio = str(row.actor);
  const detail = row.detail;
  if (!signature || !portfolio || !detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const reason = typeof d.reason === "number" ? d.reason : Number(d.reason);
  if (!Number.isInteger(reason)) return null;
  const copy = reduceNoticeCopy(reason);
  if (!copy) return null;
  const slot = row.slot === null || row.slot === undefined ? null : Number(row.slot);
  return {
    signature,
    market: str(row.slab_address),
    portfolio,
    at: str(row.block_time),
    slot: slot !== null && Number.isFinite(slot) ? slot : null,
    reason,
    lpStop: reason === REDUCE_REASON_V22.LP_STOP,
    title: copy.title,
    body: copy.body,
    reducedQ: str(row.amount),
    priceE6: str(d.price_e6),
  };
}

/** `?portfolios=a,b,c` -> distinct valid base58 addresses, at most {@link REDUCE_EVENTS_MAX_PORTFOLIOS}. */
export function parsePortfolioList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    if (out.length >= REDUCE_EVENTS_MAX_PORTFOLIOS) break;
    try {
      const k = new PublicKey(part.trim()).toBase58();
      if (!out.includes(k)) out.push(k);
    } catch {
      // not an address: skipped
    }
  }
  return out;
}

/**
 * Client side: ask the route for these portfolios' events, {@link REDUCE_EVENTS_MAX_PORTFOLIOS} per request, merged newest first and
 * de-duplicated by (signature, portfolio). `available` is false if ANY request could not be answered (the screen then says the history
 * may be incomplete rather than claiming "nothing happened").
 */
export async function fetchReduceEvents(
  wallet: string,
  portfolios: readonly string[],
  fetchJson: (url: string) => Promise<{ available?: boolean; events?: ReduceEventView[] } | null>,
): Promise<{ available: boolean; events: ReduceEventView[] }> {
  let available = true;
  const seen = new Set<string>();
  const events: ReduceEventView[] = [];
  for (let i = 0; i < portfolios.length; i += REDUCE_EVENTS_MAX_PORTFOLIOS) {
    const chunk = portfolios.slice(i, i + REDUCE_EVENTS_MAX_PORTFOLIOS);
    let body: { available?: boolean; events?: ReduceEventView[] } | null = null;
    try {
      body = await fetchJson(`/api/trader/${encodeURIComponent(wallet)}/reduce-events?portfolios=${chunk.map(encodeURIComponent).join(",")}`);
    } catch {
      body = null;
    }
    if (!body || body.available !== true) {
      available = false;
      continue;
    }
    for (const e of body.events ?? []) {
      const k = `${e.signature}:${e.portfolio}`;
      if (seen.has(k)) continue;
      seen.add(k);
      events.push(e);
    }
  }
  events.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || (b.slot ?? 0) - (a.slot ?? 0));
  return { available, events };
}
