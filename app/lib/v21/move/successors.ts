/**
 * v1 -> v2.1 market map. DATA, not code: fed from NEXT_PUBLIC_V21_SUCCESSORS_JSON (set at deploy once
 * the seed has produced the slabs) over the seeded defaults below. An entry with `v21Slab: null` is
 * the explicit "no successor yet" state: the flow stops at "withdrawn to your wallet".
 */
import { PublicKey } from "@solana/web3.js";

export interface SuccessorEntry {
  symbol: string;
  /** Underlying token mint (null until known; then matched by symbol). */
  mint: string | null;
  /** v2.1 perp market (slab). null = no successor yet. */
  v21Slab: string | null;
  /** The v2.1 market has an Earn vault to deposit into. */
  v21Earn: boolean;
}

/** Seeded list (ledger v21 seed list). Slabs are filled in when the v2.1 seed exists. */
export const DEFAULT_SUCCESSORS: readonly SuccessorEntry[] = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112", v21Slab: null, v21Earn: true },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", v21Slab: null, v21Earn: true },
  { symbol: "TRUMP", mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", v21Slab: null, v21Earn: true },
  { symbol: "PENGU", mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", v21Slab: null, v21Earn: true },
  { symbol: "BURNIE", mint: null, v21Slab: null, v21Earn: true },
  { symbol: "Percolator", mint: null, v21Slab: null, v21Earn: true },
];

const okKey = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    return new PublicKey(v).toBase58() === v;
  } catch {
    return false;
  }
};

/** Parse + validate an override list; malformed entries are dropped (never guessed). */
export function parseSuccessors(json: string | undefined): SuccessorEntry[] {
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SuccessorEntry[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.symbol !== "string" || !r.symbol) continue;
    const mint = r.mint === null || r.mint === undefined ? null : okKey(r.mint) ? r.mint : undefined;
    if (mint === undefined) continue;
    const v21Slab = r.v21Slab === null || r.v21Slab === undefined ? null : okKey(r.v21Slab) ? r.v21Slab : undefined;
    if (v21Slab === undefined) continue;
    out.push({ symbol: r.symbol, mint, v21Slab, v21Earn: r.v21Earn === true });
  }
  return out;
}

/** Defaults overlaid with overrides (matched by mint, else symbol). */
export function loadSuccessors(json: string | undefined = process.env.NEXT_PUBLIC_V21_SUCCESSORS_JSON): SuccessorEntry[] {
  const merged = DEFAULT_SUCCESSORS.map((d) => ({ ...d }));
  for (const o of parseSuccessors(json)) {
    const i = merged.findIndex((d) => (o.mint && d.mint === o.mint) || d.symbol.toLowerCase() === o.symbol.toLowerCase());
    if (i >= 0) merged[i] = { ...merged[i], ...o, mint: o.mint ?? merged[i].mint };
    else merged.push(o);
  }
  return merged;
}

export function successorFor(map: readonly SuccessorEntry[], mint: string | null, symbol: string): SuccessorEntry | null {
  const base = symbol.replace(/-PERP$/i, "").toLowerCase();
  return (
    (mint ? map.find((e) => e.mint === mint) : undefined) ??
    map.find((e) => e.symbol.toLowerCase() === base) ??
    null
  );
}
