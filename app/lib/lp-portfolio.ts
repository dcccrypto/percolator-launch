import { Buffer } from "node:buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import {
} from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
import { resolveMarketLp, selectMarketLpsFromScan } from "@/lib/market-lp";
import { parsePortfolio, portfolioGpaFilters } from "@/lib/v22/layout";

/**
 * On-chain "Market LP" (the v17 LP-portfolio account that backs a market as
 * counterparty) lookup — server-side helper shared by /api/markets and
 * /api/markets/[slab].
 *
 * Why this exists: the `markets_with_stats` Supabase view's `vault_balance`/
 * `c_tot` columns are populated by the indexer's v12 stats collector, which
 * never ran against v17 markets — both columns are NULL for every v17 row,
 * so the "Market LP" stat rendered as "—" everywhere (GH#2334 relabel didn't
 * fix the underlying null source). The real number lives on-chain: the market's
 * LP portfolio (the AMM counterparty) — chosen by on-chain identity in
 * lib/market-lp.ts, the same resolver the trade path uses — and its `capital`
 * field (collateral atoms) is the market's real LP backing. NOT "the portfolio
 * with an enabled matcher": anyone can enable one on their own portfolio.
 */

/** v17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0 */
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/**
 * Fixed byte-length of every v18 portfolio account (SDK V17_PORTFOLIO_ACCOUNT_LEN
 * = 9563; was 9347 in v17). Every portfolio account on the wrapper program — LP or
 * trader — is this exact size, so it doubles as a cheap `dataSize` filter for the
 * all-markets scan below. Imported from the SDK so it tracks the layout.
 */

/** Parse `capital` (collateral atoms, u128) from a v17 portfolio account. Null on any parse failure. */
function readCapitalSafe(data: Buffer): bigint | null {
  try {
    return parsePortfolio(new Uint8Array(data)).capital;
  } catch {
    return null;
  }
}

/**
 * Known LP-portfolio address for a curated (PLAYGROUND_SLAB_META) market —
 * discovered once via getProgramAccounts and hardcoded so the list route can
 * do a single cheap getMultipleAccountsInfo instead of a per-market scan.
 */
export function getKnownLpPortfolioAddress(slab: string): string | null {
  return PLAYGROUND_SLAB_META[slab]?.lp_portfolio_address ?? null;
}

/**
 * Batched real Market-LP lookup for the bulk /api/markets list — one
 * getMultipleAccountsInfo call covering every slab with a *known* curated
 * LP-portfolio address. Slabs without a known address are simply absent from
 * the returned map; callers keep their existing "—" fallback for those
 * (wizard-launched markets — see discoverMarketLpCapital for the per-market
 * scan used on the trade-page detail route instead).
 */
export async function getKnownMarketLpCapitals(
  connection: Connection,
  slabs: string[],
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  const entries = slabs
    .map((slab) => ({ slab, addr: getKnownLpPortfolioAddress(slab) }))
    .filter((e): e is { slab: string; addr: string } => !!e.addr);
  if (entries.length === 0) return result;

  try {
    const pubkeys = entries.map((e) => new PublicKey(e.addr));
    // Curated-only today (small, hardcoded), but chunked defensively so this
    // doesn't silently break if the curated list ever grows past 100.
    const infos = await getMultipleAccountsInfoChunked(connection, pubkeys);
    infos.forEach((info, i) => {
      if (!info?.data) return;
      const capital = readCapitalSafe(Buffer.from(info.data));
      if (capital != null) result.set(entries[i].slab, capital);
    });
  } catch {
    // RPC failure — callers keep their existing vault_balance/c_tot fallback.
  }
  return result;
}

/**
 * Batched real Market-LP lookup for EVERY market on the wrapper program,
 * including wizard-launched markets that have no hardcoded
 * `lp_portfolio_address` in PLAYGROUND_SLAB_META (getKnownMarketLpCapitals
 * only covers the curated seeds). One getProgramAccounts scan filtered
 * server-side to portfolio accounts (magic + fixed account length), grouped by
 * market, and each market's LP chosen by identity (lib/market-lp.ts
 * selectMarketLpsFromScan: one batched read of the markets + matcher ctxs).
 * Unlike discoverMarketLpCapital (one getProgramAccounts call
 * per market), this is a single call that covers all markets at once — safe
 * to call once per /api/markets request.
 */
export async function scanEnabledMarketLpCapitals(
  connection: Connection,
  programId: PublicKey,
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  try {
    // v18: the matcher `enabled` flag is now bit 0 of a packed control word, which
    // a memcmp filter can't express (the other bits vary per portfolio). Filter on
    // magic + the fixed account length only, then check `matcherEnabled` per row
    // from the SDK parse below.
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        ...portfolioGpaFilters(),
      ],
    });
    // The market's LP by on-chain identity (lib/market-lp.ts) — never "an enabled matcher
    // with the most capital": anyone can enable a matcher and fund their own portfolio.
    const rows = accounts.map(({ pubkey, account }) => ({ pubkey, data: new Uint8Array(account.data) }));
    const lps = await selectMarketLpsFromScan(connection, programId, rows);
    for (const [slab, lp] of lps) {
      const capital = readCapitalSafe(Buffer.from(lp.data));
      if (capital != null) result.set(slab, capital);
    }
  } catch {
    // RPC failure (unsupported on this cluster, rate-limited, etc.) —
    // callers keep their existing vault_balance/c_tot fallback.
  }
  return result;
}

/**
 * Full on-chain LP-portfolio discovery for a single market: scans for the
 * standalone portfolio account with an enabled matcher config (the AMM
 * counterparty). Mirrors hooks/useTrade.ts's v17 trade-account discovery.
 * One getProgramAccounts call — fine for a single market (trade-page detail
 * only; never called per-row from the bulk list).
 */
export async function discoverMarketLpCapital(
  connection: Connection,
  programId: PublicKey,
  marketPk: PublicKey,
): Promise<bigint | null> {
  try {
    const lp = await resolveMarketLp(connection, programId, marketPk);
    if (lp) return readCapitalSafe(Buffer.from(lp.data));
  } catch {
    // Discovery failed (RPC error, unsupported on this cluster, etc.) — caller
    // keeps its existing fallback.
  }
  return null;
}

/**
 * Real Market-LP lookup for a single market: known-address fast path first
 * (one getAccountInfo call for curated seeds), full getProgramAccounts scan
 * otherwise (wizard-launched markets). Used by /api/markets/[slab].
 */
export async function getMarketLpCapital(
  connection: Connection,
  programId: PublicKey,
  slab: string,
): Promise<bigint | null> {
  let marketPk: PublicKey;
  try {
    marketPk = new PublicKey(slab);
  } catch {
    return null;
  }
  const known = getKnownLpPortfolioAddress(slab);
  if (known) {
    try {
      // The curated address must still pass every identity rule (lib/market-lp.ts).
      const lp = await resolveMarketLp(connection, programId, marketPk, new PublicKey(known));
      if (lp) return readCapitalSafe(Buffer.from(lp.data));
    } catch {
      // Fall through to the discovery scan below.
    }
  }
  return discoverMarketLpCapital(connection, programId, marketPk);
}
