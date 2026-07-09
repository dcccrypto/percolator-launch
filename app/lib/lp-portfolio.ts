import { Buffer } from "node:buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { parsePortfolioV17 } from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

/**
 * On-chain "Market LP" (the v17 LP-portfolio account that backs a market as
 * counterparty) lookup — server-side helper shared by /api/markets and
 * /api/markets/[slab].
 *
 * Why this exists: the `markets_with_stats` Supabase view's `vault_balance`/
 * `c_tot` columns are populated by the indexer's v12 stats collector, which
 * never ran against v17 markets — both columns are NULL for every v17 row,
 * so the "Market LP" stat rendered as "—" everywhere (GH#2334 relabel didn't
 * fix the underlying null source). The real number lives on-chain: each v17
 * market has exactly one standalone portfolio account with an *enabled*
 * PortfolioMatcherConfigV16 — that's the LP acting as AMM counterparty — and
 * its `capital` field (collateral atoms) is the market's real LP backing.
 *
 * Byte layout mirrors hooks/useTrade.ts's v17 trade-account discovery
 * (kept in sync manually — update both if the program layout changes).
 */

/** v17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0 */
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
/** Provenance header offset: HEADER_LEN(16) + provenance.market_group_id(0) */
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
/** sizeof(PortfolioMatcherConfigV16), appended at the end of the account. */
const PORTFOLIO_MATCHER_CONFIG_LEN = 104;

/** True if the account's trailing PortfolioMatcherConfigV16.enabled == 1. */
function isMatcherEnabled(data: Buffer): boolean {
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN) return false;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return dv.getBigUint64(off + 96, true) === 1n;
}

/** Parse `capital` (collateral atoms, u128) from a v17 portfolio account. Null on any parse failure. */
function readCapitalSafe(data: Buffer): bigint | null {
  try {
    return parsePortfolioV17(new Uint8Array(data)).capital;
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
    const infos = await connection.getMultipleAccountsInfo(pubkeys);
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
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
        { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: marketPk.toBase58() } },
      ],
    });
    for (const { account } of accounts) {
      const data = Buffer.from(account.data);
      if (!isMatcherEnabled(data)) continue;
      const capital = readCapitalSafe(data);
      if (capital != null) return capital;
    }
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
  const known = getKnownLpPortfolioAddress(slab);
  if (known) {
    try {
      const info = await connection.getAccountInfo(new PublicKey(known));
      if (info?.data) {
        const capital = readCapitalSafe(Buffer.from(info.data));
        if (capital != null) return capital;
      }
    } catch {
      // Fall through to the discovery scan below.
    }
  }
  let marketPk: PublicKey;
  try {
    marketPk = new PublicKey(slab);
  } catch {
    return null;
  }
  return discoverMarketLpCapital(connection, programId, marketPk);
}
