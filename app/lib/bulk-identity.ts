/**
 * Market IDENTITY (ticker / name / logo / mainnet CA) resolved independently of
 * the slow per-market detail fetch.
 *
 * WHY THIS EXISTS
 *
 * /my-markets showed a placeholder instead of the ticker for about a second on
 * every load. The page resolved identity from `/api/markets/[slab]`, one request
 * per market — and that route awaits `withOnChainMarketLp(...)` before it
 * responds (see app/api/markets/[slab]/route.ts), i.e. every row's TICKER was
 * gated on that row's ON-CHAIN LP SCAN. Measured on the live playground:
 * 517-1022ms per market.
 *
 * The bulk directory answers the identity question for every market at once.
 * Measured against the deployed playground: `/api/markets?limit=500` returned
 * all 9 markets in 117-192ms. One round trip, no per-market on-chain scan.
 *
 * WHAT THE BULK ROUTE ACTUALLY CARRIES — measured, not assumed, and it VARIES
 * BY DEPLOYMENT, which is the whole reason nothing here assumes a field set.
 * On the playground (11 markets): `symbol` and `name` on 11/11, `mainnet_ca`
 * and `dex_pool_address` on 10/11, `logo_url` on 4/11. On a second, stale
 * deployment the same route returned symbol+name only, with `logo_url`,
 * `mainnet_ca` and `dex_pool_address` as ABSENT KEYS rather than nulls —
 * despite the route's own row builder setting all three.
 *
 * `parseBulkIdentities` therefore takes whatever identity fields a row happens
 * to carry and ignores the rest. What that buys, per field:
 *
 *   - TICKER: correct in one round trip, always.
 *   - LOGO: immediate for a row carrying `logo_url`. For a row carrying only
 *     `mainnet_ca`, MarketLogo's /api/token-logo hop can START as soon as this
 *     call lands instead of waiting out the per-market detail — roughly
 *     400-900ms earlier — but it is still a second request.
 *   - Neither: falls back to the symbol's initials, which the faster ticker
 *     improves on its own.
 *
 * `resolveIdentity` is the other half: identity arrives from three sources at
 * three different times (the session cache synchronously, the bulk directory in
 * ~150ms, the per-market detail in ~1s) and they disagree by being SPARSE, not
 * by being wrong. Merging per ENTRY lets a later, sparser source blank a field
 * an earlier one knew — which showed up as a row painting its real ticker and
 * then degrading to a truncated mint address when the detail landed with
 * `symbol: null` (the `onChainSlabFallback` path supplies no `logo_url` key at
 * all and a null symbol whenever the market is not in PLAYGROUND_SLAB_META or
 * the registration blob). Merging per FIELD is what makes identity only ever
 * sharpen.
 */

import { isPlaceholderTicker } from "@/lib/unfinished-launch";

/** The identity fields any source may contribute. Null = this source does not
 *  know the field; it is NOT an assertion that the market has no value. */
export interface ResolvedIdentity {
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  mainnet_ca: string | null;
}

/** A source may know any subset, and may spell absence as null OR undefined
 *  (the identity cache uses optional fields, the API rows use nulls). */
export type IdentitySource = {
  symbol?: string | null;
  name?: string | null;
  logo_url?: string | null;
  mainnet_ca?: string | null;
} | null | undefined;

const EMPTY: ResolvedIdentity = { symbol: null, name: null, logo_url: null, mainnet_ca: null };

/** Empty strings are absence, not a value — an API row with `symbol: ""` must
 *  not win over a cache that knows the real ticker, and `""` would render as a
 *  blank label, which reads as "this market has no name". */
function present(v: string | null | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The ticker only: the indexer's "UNKNOWN" placeholder (an unfinished or unregistered launch)
 *  is "no ticker", not a ticker. Without this it won over every better source, because the
 *  per-market detail is first in precedence (#3266). */
function presentTicker(v: string | null | undefined): string | null {
  const t = present(v);
  return t !== null && !isPlaceholderTicker(t) ? t : null;
}

/** True when any source carried the placeholder ticker: identity HAS loaded, it just knows nothing. */
export function sawPlaceholderTicker(...sources: IdentitySource[]): boolean {
  return sources.some((s) => !!s && isPlaceholderTicker(s.symbol));
}

/**
 * Field-level merge across sources given in PRECEDENCE ORDER (most
 * authoritative first). For each field independently, the first source that
 * actually has it wins.
 *
 * Per-field is the whole point: a later source that does not know `symbol` must
 * not erase a `symbol` an earlier one supplied. Same rule the identity cache
 * itself uses for its writes (lib/marketIdentityCache.ts setMarketIdentity).
 */
export function resolveIdentity(...sources: IdentitySource[]): ResolvedIdentity {
  const out: ResolvedIdentity = { ...EMPTY };
  for (const source of sources) {
    if (!source) continue;
    out.symbol ??= presentTicker(source.symbol);
    out.name ??= present(source.name);
    out.logo_url ??= present(source.logo_url);
    out.mainnet_ca ??= present(source.mainnet_ca);
  }
  return out;
}

/**
 * True when a resolved identity carries anything usable.
 *
 * `mainnet_ca` counts. It renders nothing by itself, but MarketLogo resolves a
 * logo from it via /api/token-logo when no explicit `logo_url` is set, so
 * dropping a CA-only entry silently costs that market its logo.
 */
export function hasAnyIdentity(identity: ResolvedIdentity): boolean {
  return (
    identity.symbol != null ||
    identity.name != null ||
    identity.logo_url != null ||
    identity.mainnet_ca != null
  );
}

/**
 * Pull per-slab identity out of a `/api/markets` list response.
 *
 * `rows` is untrusted shape (the payload's field set varies by deployment, as
 * the module comment documents), so every field is probed rather than assumed.
 * Rows for slabs outside `allowedSlabs` are dropped: the directory lists EVERY
 * market, and this creator's dashboard must not gain entries for markets they
 * do not own.
 *
 * A row that contributes no identity at all is omitted entirely rather than
 * stored as an empty record, so callers can treat "has a key" as "knows
 * something".
 */
export function parseBulkIdentities(
  rows: unknown,
  allowedSlabs: readonly string[],
): Record<string, ResolvedIdentity> {
  const out: Record<string, ResolvedIdentity> = {};
  if (!Array.isArray(rows)) return out;
  const allowed = new Set(allowedSlabs);

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const slab = typeof r.slab_address === "string" ? r.slab_address : null;
    if (!slab || !allowed.has(slab)) continue;

    const identity = resolveIdentity({
      symbol: typeof r.symbol === "string" ? r.symbol : null,
      name: typeof r.name === "string" ? r.name : null,
      logo_url: typeof r.logo_url === "string" ? r.logo_url : null,
      mainnet_ca: typeof r.mainnet_ca === "string" ? r.mainnet_ca : null,
    });
    if (hasAnyIdentity(identity)) out[slab] = identity;
  }
  return out;
}
