/**
 * Keeper enrollment guard (code review 2026-10-01, M-7).
 *
 * Every market the keeper prices costs it SOL on every push, and the keeper signs one batch for
 * all of them. Before this guard, POST /api/playground/keeper-register enrolled ANY wrapper-owned
 * v18 market whose creation tx carried the memo: a script could create bare markets, co-sign each
 * through the public cosign route and register it, draining the keeper wallet and taking the real
 * markets stale with it. Two checks close that:
 *
 *   1. READINESS (`checkKeeperReadiness`, from the slab bytes the route already read, no extra
 *      RPC): the market finished the launch. Measured against the deployed wrapper (553d76f0,
 *      `WrapperConfigV16` / `AssetOracleProfileV16` / `MarketGroupV16HeaderAccount`):
 *        - marketauth == the stake-pool PDA (percolator-stake InitPool, the launch's LAST step,
 *          rotates it there; see lib/market-completeness.ts);
 *        - insurance > 0 (M3b's seed);
 *        - c_tot > 0, i.e. the LP's collateral is in (M2 / M3a);
 *        - asset 0 is AUTH_MARK (mode 3) with oracle_authority == the playground keeper.
 *   2. CAPS (`checkEnrollmentCaps`): a ceiling on enrolled markets, globally and per creator,
 *      applied only when a registration would newly enroll a market.
 *
 * The keeper applies its own ceiling as well (percolator-oracle-keeper db-markets.ts), so a row
 * that reaches the table some other way still cannot grow the push batch without bound.
 */
import { PublicKey } from "@solana/web3.js";
import {
  deriveStakePool,
  parseAssetOracleProfileV17,
  parseMarketGroupV17OI,
  parseWrapperConfigV17,
  V17_HEADER_LEN,
  V17_MARKET_GROUP_OFF,
} from "@percolatorct/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assetProfileOff } from "@/lib/v18-wire";

/** AUTH_MARK: the keeper pushes the mark (wrapper ORACLE_MODE_AUTH_MARK). */
export const ORACLE_MODE_AUTH_MARK = 3;
/** `MarketGroupV16HeaderAccount.c_tot` (u128), relative to V17_MARKET_GROUP_OFF (lib/v18-wire.ts). */
const MG_C_TOT_OFF = 317;

export type ReadinessFailure = "unconfigured" | "unreadable" | "incomplete" | "no-insurance" | "no-liquidity" | "oracle-not-keeper";
export type ReadinessVerdict = { ok: true } | { ok: false; reason: ReadinessFailure };

function readU128LE(data: Uint8Array, off: number): bigint {
  const dv = new DataView(data.buffer, data.byteOffset + off, 16);
  return dv.getBigUint64(0, true) | (dv.getBigUint64(8, true) << 64n);
}

/**
 * Is this market finished and priced by OUR keeper? Fails closed: a missing stake program or
 * keeper key ("unconfigured") and bytes that don't parse ("unreadable") both refuse.
 */
export function checkKeeperReadiness(
  data: Uint8Array,
  slab: PublicKey,
  stakeProgramId: string | null | undefined,
  keeperPubkey: string | null | undefined,
): ReadinessVerdict {
  if (!stakeProgramId || !keeperPubkey) return { ok: false, reason: "unconfigured" };
  let marketauth: PublicKey;
  let insurance: bigint;
  let cTot: bigint;
  let oracleMode: number;
  let oracleAuthority: PublicKey;
  try {
    marketauth = parseWrapperConfigV17(data, V17_HEADER_LEN).marketauth;
    insurance = parseMarketGroupV17OI(data).insuranceBalance;
    if (data.length < V17_MARKET_GROUP_OFF + MG_C_TOT_OFF + 16) return { ok: false, reason: "unreadable" };
    cTot = readU128LE(data, V17_MARKET_GROUP_OFF + MG_C_TOT_OFF);
    const profile = parseAssetOracleProfileV17(data, assetProfileOff(0));
    oracleMode = profile.oracleMode;
    oracleAuthority = profile.oracleAuthority;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let stakePool: PublicKey;
  try {
    [stakePool] = deriveStakePool(slab, new PublicKey(stakeProgramId));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (oracleMode !== ORACLE_MODE_AUTH_MARK || oracleAuthority.toBase58() !== keeperPubkey) {
    return { ok: false, reason: "oracle-not-keeper" };
  }
  if (!marketauth.equals(stakePool)) return { ok: false, reason: "incomplete" };
  if (insurance <= 0n) return { ok: false, reason: "no-insurance" };
  if (cTot <= 0n) return { ok: false, reason: "no-liquidity" };
  return { ok: true };
}

/** HTTP status for a readiness refusal. Not finished yet = 409, which the launch's background
 *  loop retries; another oracle = 403 (final); a server without its keys = 503. */
export function readinessStatus(reason: ReadinessFailure): number {
  switch (reason) {
    case "oracle-not-keeper":
      return 403;
    case "unreadable":
      return 400;
    case "unconfigured":
      return 503;
    default:
      return 409;
  }
}

/** Shown when a creator hits the per-wallet ceiling (final; a maintainer can enroll more). */
export const PER_CREATOR_CAP_COPY = "This wallet already has the most live-priced markets allowed.";
/** Shown when the deployment's ceiling is full (not final: it clears once room is made). */
export const GLOBAL_CAP_COPY = "Live prices are full right now. A maintainer can connect this market.";

/**
 * The deployment-wide ceiling. 50 filled on 2026-10-05 20:14 UTC (the 50th active row, PLAGUE) and
 * from then on EVERY new launch was refused with a final 403 for 28+ hours: ~25 markets, 7+
 * deployers, all left "UNKNOWN" with no live price. The playground adds ~10 live markets a day, so
 * the ceiling is sized for weeks, and a refusal for it is retryable (429, below), never final.
 */
export const DEFAULT_MAX_ACTIVE_MARKETS = 200;
export const DEFAULT_MAX_ACTIVE_PER_CREATOR = 10;

export interface EnrollmentCaps {
  maxActive: number;
  maxActivePerCreator: number;
}

function envInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** KEEPER_MAX_ACTIVE_MARKETS / KEEPER_MAX_ACTIVE_PER_CREATOR, else the defaults. */
export function enrollmentCapsFromEnv(env: NodeJS.ProcessEnv = process.env): EnrollmentCaps {
  return {
    maxActive: envInt(env.KEEPER_MAX_ACTIVE_MARKETS, DEFAULT_MAX_ACTIVE_MARKETS),
    maxActivePerCreator: envInt(env.KEEPER_MAX_ACTIVE_PER_CREATOR, DEFAULT_MAX_ACTIVE_PER_CREATOR),
  };
}

export type CapVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string; detail?: string; capFull?: boolean };

/**
 * Would enrolling `slab` for `deployer` exceed a ceiling? Counts the OTHER active rows on this
 * network (the slab itself never counts against its own registration). A count that cannot be
 * read refuses (503, retryable): an unbounded enrollment is the failure this exists to stop.
 */
export async function checkEnrollmentCaps(
  supabase: SupabaseClient,
  args: { slab: string; deployer: string; network: string },
  caps: EnrollmentCaps,
): Promise<CapVerdict> {
  const base = () =>
    supabase
      .from("markets")
      .select("slab_address", { count: "exact", head: true })
      .eq("network", args.network)
      .eq("keeper_status", "active")
      .neq("slab_address", args.slab);
  const [all, mine] = await Promise.all([base(), base().eq("deployer", args.deployer)]);
  const err = all.error ?? mine.error;
  if (err || typeof all.count !== "number" || typeof mine.count !== "number") {
    return {
      ok: false,
      status: 503,
      error: "Live price couldn't connect just now. Your market is live; try again in a moment.",
      detail: err ? `${err.code ?? ""} ${err.message ?? ""}`.trim() : "count unavailable",
    };
  }
  if (mine.count >= caps.maxActivePerCreator) return { ok: false, status: 403, error: PER_CREATOR_CAP_COPY };
  // 429, not 403: a full deployment is a state that clears (a maintainer raises the ceiling or
  // retires dead markets), not a verdict on this market. The launch screen and the resume pass
  // keep retrying a 429 and never write the "refused" tombstone for it. The route reports it to
  // Sentry at error level: the previous silent 403 hid a total outage for a day.
  if (all.count >= caps.maxActive) return { ok: false, status: 429, error: GLOBAL_CAP_COPY, capFull: true };
  return { ok: true };
}
