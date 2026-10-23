/**
 * The market switcher's three lists (Top markets / My trades / Watchlist) and its search, as pure functions
 * over the market stats map, so each list can be checked without rendering the dropdown.
 */
import { isBrowsableMarketRow } from "@/lib/listed-markets";

export interface SwitcherRow {
  slab: string;
  symbol: string;
  name: string | null;
  priceUsd: number | null;
  /** Ranking score only (raw OI atoms x price), never displayed. */
  oiScore: number;
  /** My trades only: the side of the open position. */
  side?: "long" | "short";
  /** The symbol is a stand-in (the market is not in the stats yet): never cache it as the market's name. */
  placeholder?: true;
}

export type SwitcherTab = "top" | "mine" | "watch";

export const SWITCHER_TABS: ReadonlyArray<{ key: SwitcherTab; label: string }> = [
  { key: "top", label: "Top markets" },
  { key: "mine", label: "My trades" },
  { key: "watch", label: "Watchlist" },
];

/** How many markets the Top tab shows (unchanged from the single-list switcher). */
export const TOP_COUNT = 3;
/** Cap on search results. */
export const SEARCH_COUNT = 8;

type StatsRow = Record<string, unknown> | null | undefined;

function toRow(slab: string, m: StatsRow): SwitcherRow | null {
  if (!m?.symbol) return null;
  const price = typeof m.last_price === "number" ? m.last_price : null;
  const oi = typeof m.total_open_interest === "number" ? m.total_open_interest : 0;
  return {
    slab,
    symbol: String(m.symbol),
    name: (m.name as string | null) ?? null,
    priceUsd: price,
    oiScore: oi * (price ?? 0),
  };
}

/** Every browsable market, ranked by open interest (then symbol). */
export function browsableRows(statsMap: ReadonlyMap<string, StatsRow>): SwitcherRow[] {
  const rows: SwitcherRow[] = [];
  for (const [slab, m] of statsMap) {
    if (!m?.symbol || !isBrowsableMarketRow(slab, m as never)) continue;
    const row = toRow(slab, m);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => b.oiScore - a.oiScore || a.symbol.localeCompare(b.symbol));
  return rows;
}

/** Search across every browsable market, whichever tab is open. */
export function searchRows(all: readonly SwitcherRow[], query: string): SwitcherRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter((r) => r.symbol.toLowerCase().includes(q) || (r.name ?? "").toLowerCase().includes(q) || r.slab.toLowerCase().startsWith(q))
    .slice(0, SEARCH_COUNT);
}

export interface OpenPositionLike {
  slabAddress: string;
  symbol: string | null;
  /** Signed size; 0 is not an open position. */
  positionSize: bigint;
}

/**
 * Markets the wallet has an open position in, one row each (a market can hold more than one position row,
 * e.g. a wrapped one), largest market first. A market missing from the stats map (hidden from browsing)
 * still shows, because it is the user's own position.
 */
export function myTradeRows(positions: readonly OpenPositionLike[], statsMap: ReadonlyMap<string, StatsRow>): SwitcherRow[] {
  const bySlab = new Map<string, SwitcherRow>();
  for (const p of positions) {
    if (p.positionSize === 0n || bySlab.has(p.slabAddress)) continue;
    const side = p.positionSize > 0n ? "long" : "short";
    const fromStats = toRow(p.slabAddress, statsMap.get(p.slabAddress));
    const row: SwitcherRow = fromStats ?? {
      slab: p.slabAddress,
      symbol: p.symbol ?? `${p.slabAddress.slice(0, 4)}…`,
      name: null,
      priceUsd: null,
      oiScore: 0,
      ...(p.symbol ? {} : { placeholder: true as const }),
    };
    bySlab.set(p.slabAddress, { ...row, side });
  }
  return [...bySlab.values()].sort((a, b) => b.oiScore - a.oiScore || a.symbol.localeCompare(b.symbol));
}

/**
 * Watched markets in the watchlist's own order: newest first (lib/watchlist.ts `addSlab` prepends), the
 * same order the portfolio watchlist panel shows. A watched market missing from the stats map is left out
 * rather than shown without a name or price, and so is one hidden from browsing (the same filter as Top).
 */
export function watchlistRows(watchlist: readonly string[], statsMap: ReadonlyMap<string, StatsRow>): SwitcherRow[] {
  const rows: SwitcherRow[] = [];
  for (const slab of watchlist) {
    const m = statsMap.get(slab);
    // A starred market that is hidden from browsing now (SI, a half-made launch, ...) is left out like on Top and search.
    if (!m?.symbol || !isBrowsableMarketRow(slab, m as never)) continue;
    const row = toRow(slab, m);
    if (row) rows.push(row);
  }
  return rows;
}

const TAB_STORAGE_KEY = "perc:market-switcher-tab:v1";

/** The tab the viewer last chose; Top markets when unknown or storage is unavailable. */
export function readSwitcherTab(): SwitcherTab {
  try {
    const v = window.localStorage.getItem(TAB_STORAGE_KEY);
    return v === "mine" || v === "watch" || v === "top" ? v : "top";
  } catch {
    return "top";
  }
}

export function saveSwitcherTab(tab: SwitcherTab): void {
  try {
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* private mode / blocked storage: the choice just isn't remembered */
  }
}
