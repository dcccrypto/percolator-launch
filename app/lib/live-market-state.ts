import { Connection, PublicKey } from "@solana/web3.js";
import {
  isV17Account,
  parseWrapperConfigV17,
  parseMarketGroupV17OI,
  V17_HEADER_LEN,
  V17_MARKET_GROUP_OFF,
} from "@percolatorct/sdk";
import { getRpcEndpoint } from "@/lib/config";
import { sanitizeOnChainValue } from "@/lib/health";

/**
 * Live per-market state, read straight from the slab account.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-07 indexer reduction stopped mirroring price, OI, insurance, vault
 * and c_tot into Postgres — they are on-chain values and the chain is the only
 * source that cannot be stale. But /api/markets kept TWO alternative paths:
 * an on-chain path that computed them, and a Supabase path that did not. The
 * Supabase path wins whenever the DB is configured, so configuring Supabase
 * silently downgraded the endpoint: `total_open_interest: 0` on markets that
 * demonstrably had OI, `activeTotal: 0` with four live markets, and a zombie
 * heuristic reading absent columns as evidence of death.
 *
 * The fix is not a third path. It is to stop branching: the registry (identity,
 * logo, 24h volume) comes from Postgres because only Postgres has it, and the
 * live state comes from here because only the chain has it. One merged row.
 *
 * COST
 * ----
 * One `getMultipleAccountsInfo` per 100 slabs — the addresses are already known
 * from the registry, so there is no discovery step. This deliberately replaces
 * the `getProgramAccounts` LP scan that used to run in the list request path:
 * that call scans the ENTIRE program, so its cost grows with protocol size
 * rather than market count, and it is the first thing an RPC provider throttles.
 * Discovery of new markets belongs to the indexer, which already does it.
 */
export interface LiveMarketState {
  /** Mark price in USD, from the config's mark EWMA. Null when unset/insane. */
  markPriceUsd: number | null;
  /** Effective long OI, raw base-asset Q (1e6 units). */
  oiLongQ: number;
  /** Effective short OI, raw base-asset Q (1e6 units). */
  oiShortQ: number;
  /** oiLongQ + oiShortQ. */
  totalOiQ: number;
  /** Total OI valued at the mark price. Null when there is no usable price. */
  totalOiUsd: number | null;
  /** Group-level insurance reserve (micro-units). */
  insurance: number;
  /** Engine vault (micro-units) — total collateral held by the market. */
  vault: number;
  /** Total collateral across portfolios (micro-units). */
  cTot: number;
}

/**
 * MarketGroupV16HeaderAccount field offsets, relative to V17_MARKET_GROUP_OFF.
 *
 * Verified against the engine's own `#[repr(C)]` via `cargo run --example
 * dump_layout`, and identical to the constants the indexer reads
 * (percolator-indexer/src/services/StatsCollector.ts):
 *
 *   +0    market_group_id [u8;32]
 *   +32   config V16ConfigAccount   (249 bytes, INLINE — precedes vault)
 *   +281  asset_slot_capacity u32
 *   +285  vault u128
 *   +301  insurance u128
 *   +317  c_tot u128
 *
 * The SDK exposes no reader for vault/c_tot (parseMarketGroupV17OI covers
 * insurance and OI only), hence the manual reads.
 */
const MG_VAULT_OFF = 285;
const MG_C_TOT_OFF = 317;
/** Must cover the c_tot read at +317 (317 + 16 bytes). */
const MG_MIN_BYTES = 333;

/**
 * Upper bound for a sane price in micro-USD (1e6).
 *
 * An unset/sentinel u64 (e.g. u64::MAX) otherwise divides out to ~$1.8e13 and
 * poisons every downstream total. Mirrors the indexer's MAX_SANE_PRICE_E6 and
 * the existing markPrice.ts guard.
 */
const MAX_SANE_PRICE_E6 = 1_000_000_000_000n;

/** getMultipleAccountsInfo accepts at most 100 addresses per call. */
const CHUNK = 100;

function readU128LE(data: Uint8Array, offset: number): bigint {
  const dv = new DataView(data.buffer, data.byteOffset + offset, 16);
  return dv.getBigUint64(0, true) | (dv.getBigUint64(8, true) << 64n);
}

/** Parse one slab's live state. Returns null if the account isn't a v17 slab. */
function parseLiveState(data: Uint8Array): LiveMarketState | null {
  if (!isV17Account(data)) return null;

  let markPriceUsd: number | null = null;
  try {
    const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const e6 = cfg.markEwmaE6;
    if (e6 > 0n && e6 < MAX_SANE_PRICE_E6) markPriceUsd = Number(e6) / 1_000_000;
  } catch {
    // Config unreadable — the row keeps a null price rather than a wrong one.
  }

  let oiLongQ = 0;
  let oiShortQ = 0;
  let insurance = 0;
  try {
    const oi = parseMarketGroupV17OI(data);
    // Sanitize sentinel/negative on-chain values (u64::MAX from an uninitialized
    // slab) to 0 before Number() — otherwise they become astronomical OI/insurance
    // that poisons total_open_interest_usd downstream. Same treatment markPrice gets.
    oiLongQ = Number(sanitizeOnChainValue(oi.totalLongOiQ));
    oiShortQ = Number(sanitizeOnChainValue(oi.totalShortOiQ));
    insurance = Number(sanitizeOnChainValue(oi.insuranceBalance));
  } catch {
    // OI unreadable — zeros, same as the pre-existing degradation behaviour.
  }

  let vault = 0;
  let cTot = 0;
  if (data.length >= V17_MARKET_GROUP_OFF + MG_MIN_BYTES) {
    try {
      vault = Number(readU128LE(data, V17_MARKET_GROUP_OFF + MG_VAULT_OFF));
      cTot = Number(readU128LE(data, V17_MARKET_GROUP_OFF + MG_C_TOT_OFF));
    } catch {
      // Leave both at 0 — callers treat 0 vault as a liveness signal, and a
      // failed read here is indistinguishable from a genuinely empty market.
    }
  }

  const totalOiQ = oiLongQ + oiShortQ;
  return {
    markPriceUsd,
    oiLongQ,
    oiShortQ,
    totalOiQ,
    totalOiUsd: markPriceUsd != null ? (totalOiQ / 1_000_000) * markPriceUsd : null,
    insurance,
    vault,
    cTot,
  };
}

/**
 * Read live state for the given slabs in batched RPC calls.
 *
 * Never throws: a chunk that fails is simply absent from the result, and
 * callers fall back to whatever the registry gave them. Partial results are
 * expected and fine — a market missing from the map renders exactly as it did
 * before this enrichment existed.
 */
export async function readLiveMarketStates(
  slabAddresses: string[],
  connection?: Connection,
): Promise<Map<string, LiveMarketState>> {
  const out = new Map<string, LiveMarketState>();
  if (slabAddresses.length === 0) return out;

  // Deduplicate and drop anything that isn't a usable pubkey before spending an
  // RPC round trip on it.
  const pubkeys: Array<{ slab: string; key: PublicKey }> = [];
  for (const slab of new Set(slabAddresses)) {
    try {
      pubkeys.push({ slab, key: new PublicKey(slab) });
    } catch {
      // Not a valid address — skip.
    }
  }
  if (pubkeys.length === 0) return out;

  const conn = connection ?? new Connection(getRpcEndpoint(), "confirmed");

  for (let start = 0; start < pubkeys.length; start += CHUNK) {
    const chunk = pubkeys.slice(start, start + CHUNK);
    try {
      const infos = await conn.getMultipleAccountsInfo(chunk.map((c) => c.key));
      infos.forEach((info, i) => {
        if (!info?.data) return;
        const state = parseLiveState(new Uint8Array(info.data));
        if (state) out.set(chunk[i].slab, state);
      });
    } catch {
      // This chunk stays unresolved; the rest still land.
    }
  }

  return out;
}
