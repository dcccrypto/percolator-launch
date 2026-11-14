/**
 * Council r10 round 2 MED: is this device's stored trade book / Entry still the position's? Size alone cannot tell: a same-size close + reopen
 * (or an add + reduce) on another device leaves it equal. A record counts only while its newest fill is the position's newest change on chain.
 *
 * Kept apart from lib/entry-chain-sync.ts so the close hook and the ticket can use it without the market decoders the rebuild needs.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { openSinceCheck, prevChangeCheck } from "@/lib/entry-chain";

/** Where lib/entry-chain-sync.ts keeps its last attempt (and walk) per portfolio. */
export const ENTRY_CHAIN_KEY = (portfolio: string) => `perc:entrychain:v1:${portfolio}`;

/** The stored walk's top signature and the newest position change it found (null when none is stored): a later check reads only what is newer. */
export function storedWalkHead(portfolio: string): { top: string; newest: string } | null {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(ENTRY_CHAIN_KEY(portfolio));
    if (!raw) return null;
    const w = (JSON.parse(raw) as { walk?: { top?: unknown; deltas?: unknown } }).walk;
    if (!w || typeof w.top !== "string" || !Array.isArray(w.deltas) || w.deltas.length === 0) return null;
    const last = w.deltas[w.deltas.length - 1] as { sig?: unknown } | null;
    return last && typeof last.sig === "string" ? { top: w.top, newest: last.sig } : null;
  } catch {
    return null;
  }
}

/**
 * The position's newest change on chain before this device's landed fill `sig`, for a stored book / Entry whose newest fill is `recordSig`.
 *   1. The transactions between them (lib/entry-chain.ts prevChangeCheck), from the stored walk's top or `recordSig`, whichever comes first,
 *      at most `maxRead` of them, paced. A just-confirmed `sig` the node has not listed yet is retried (only that case: a read limit is not).
 *   2. When that cannot tell (a long hold with no fresh walk), the signature list alone (openSinceCheck): no open from flat by the app since
 *      `recordSig` returns `recordSig` (the record stands, as it did before this check existed); one returns that open's signature.
 * Null = could not be told: the caller then trusts no stored book or Entry for this fill (unknown, never the old numbers).
 */
export async function prevChangeBeforeFill(
  connection: Pick<Connection, "getSignaturesForAddress" | "getTransaction"> & Partial<Pick<Connection, "getTransactions">>,
  wrapper: PublicKey,
  t: { market: PublicKey; portfolio: PublicKey; sig: string; assetIndex?: number; recordSig?: string | null },
  o: { tries?: number; waitMs?: number; maxRead?: number; paceMs?: number } = {},
): Promise<string | null> {
  const tries = o.tries ?? 6;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, o.waitMs ?? 1500));
    const r = await prevChangeCheck(connection, wrapper, {
      market: t.market, portfolio: t.portfolio, assetIndex: t.assetIndex, beforeSig: t.sig, stopAt: t.recordSig ?? null,
      known: storedWalkHead(t.portfolio.toBase58()), maxRead: o.maxRead ?? 100, paceMs: o.paceMs ?? 100,
    });
    if (r.kind === "sig") return r.sig;
    if (r.kind === "unknown") break;
  }
  if (!t.recordSig) return null;
  const m = await openSinceCheck(connection, t.portfolio, { untilSig: t.recordSig, fromSig: t.sig });
  if (m.kind === "none") return t.recordSig;
  if (m.kind === "memo") return m.sig;
  return null;
}
