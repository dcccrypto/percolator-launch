import { Connection, PublicKey } from "@solana/web3.js";
import { isAcceptedWrapper } from "@/lib/v21/worlds";
import {
  isV17Account,
  parseWrapperConfigV17,
  parseMarketGroupV17OI,
  V17_HEADER_LEN,
  V17_MARKET_GROUP_OFF,
} from "@percolatorct/sdk";
import { getServerConnection } from "@/lib/server-rpc";
import { sanitizeOnChainValue } from "@/lib/health";
import { isMarketauthComplete } from "@/lib/market-completeness";
import { parseV17RiskParams } from "@/lib/v17-engine-config";
import { leverageFromMarginBps } from "@/lib/market-params";
import { isClosedMarketTombstone, TOMBSTONE_PROBE_SLICE_LEN } from "@/lib/closed-market-tombstone";

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
  /**
   * BUG FIX (2026-09-25, tester-reported: a market that failed partway through
   * creation — e.g. died at "Create Earn vault" before ever reaching stake-pool
   * init — still showed up in /markets and my-markets).
   *
   * True once the market has run every step of the create-market wizard,
   * including the FINAL one (percolator-stake InitPool). That instruction
   * irreversibly rotates WrapperConfigV17.marketauth from the creator's wallet
   * to the stake-pool PDA (see useCreateMarket.ts's Step 5 comment: "Stake
   * InitPool ... ROTATES on-chain marketauth from this wallet to the
   * stake-pool PDA" and CreateLpVault's own marketauth-gating — that rotation
   * is deliberately the LAST on-chain mutation any create-market path
   * performs). So `marketauth == derive("stake_pool", slab)` under the
   * network's stake program is a free, zero-extra-RPC completeness signal:
   * it's read off the SAME slab account this file already fetches for price/
   * OI/vault, just compared against a deterministic PDA instead of a fixed
   * offset. No stake program pinned for this network (mainnet today — see
   * PERCOLATOR_ERRORS[60] StakeProgramNotPinned) ⇒ the stake step doesn't
   * apply here, so every market is treated as complete rather than filtered.
   */
  isComplete: boolean;
  /**
   * base58 owner program of the slab account (set by readLiveMarketStates). A slab owned by
   * anything but the CURRENT wrapper is a market of an abandoned program (the 2026-10 relaunch
   * moved to all-fresh IDs): lib/market-registry.ts drops it from every listing.
   */
  owner?: string;
  /**
   * Max leverage cap derived from the market's REAL on-chain initialMarginBps
   * (round(10000 / bps)). This is the same figure /api/markets' on-chain
   * discovery path computes via computeMaxLeverage — but the Supabase list path
   * (the one that actually serves the deployed site) never had it, so every
   * market fell back to the DB's stored max_leverage of 10. That is correct only
   * by coincidence for 1000bps markets and wrong for the rest (e.g. SOL at
   * 666bps is 15x, COLLECT at 1538bps is ~7x). Read off the SAME slab bytes this
   * file already fetches, so it costs zero extra RPC. Null when the engine-config
   * region can't be read — the caller then keeps whatever the registry row had.
   */
  maxLeverage: number | null;
}

// isMarketauthComplete lives in lib/market-completeness.ts (client-safe: this
// file pulls in the server-only RPC helper). Re-exported so server callers and
// existing imports keep working.
export { isMarketauthComplete };

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
function parseLiveState(data: Uint8Array, slabKey: PublicKey): LiveMarketState | null {
  if (!isV17Account(data)) return null;

  let markPriceUsd: number | null = null;
  // Default to complete: no stake program pinned for this network (mainnet
  // today) means the stake step doesn't gate anything here — see the
  // isComplete doc comment above. Only devnet, where the stake program IS
  // pinned, can flip this to false.
  let isComplete = true;
  // Null until read: leaving it null (not 10) makes the caller keep the
  // registry's stored max_leverage on an RPC/parse gap, rather than clobbering
  // it with a wrong-but-plausible fallback. See LiveMarketState.maxLeverage.
  let maxLeverage: number | null = null;
  try {
    const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const e6 = cfg.markEwmaE6;
    if (e6 > 0n && e6 < MAX_SANE_PRICE_E6) markPriceUsd = Number(e6) / 1_000_000;

    // Same signal the discovery path uses; no stake program pinned (mainnet
    // today) => complete, PDA derivation failure => fail closed.
    isComplete = isMarketauthComplete(cfg.marketauth, slabKey);

    // Real per-market leverage cap from the engine's initialMarginBps — the same
    // derivation /api/markets' on-chain discovery path uses (computeMaxLeverage
    // -> leverageFromMarginBps). Parsed from the SAME bytes already in hand.
    //
    // Isolated in its OWN try so a leverage-parse failure degrades only
    // maxLeverage (to null → caller keeps the DB value) and can never reach the
    // outer catch, which fails isComplete CLOSED and thereby HIDES the market
    // from the list — a leverage read has no business doing that. Mirrors how the
    // OI and vault reads below are each isolated. parseV17RiskParams is throw-free
    // today (it length-guards and every field read lands inside CONFIG_READ_LEN),
    // so this is defence-in-depth against a future edit that reads past that guard.
    try {
      const risk = parseV17RiskParams(data, cfg.tradeFeeBps);
      if (risk && risk.initialMarginBps > 0n) {
        const lev = leverageFromMarginBps(Number(risk.initialMarginBps));
        if (Number.isFinite(lev) && lev > 0) maxLeverage = lev;
      }
    } catch {
      // Leverage unreadable — leave maxLeverage null; isComplete/price stand.
    }
  } catch {
    // Config unreadable — the row keeps a null price rather than a wrong one.
    // Unreadable also means we can't prove completeness — fail closed (not
    // complete) rather than let an unparseable slab through the filter.
    isComplete = false;
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
    isComplete,
    maxLeverage,
  };
}

/**
 * Resolution-aware result for batched slab reads (GH#2988).
 *
 * - `missing`: confirmed dead. Either (a) the RPC call succeeded and returned an explicit `null`
 *   (never existed / garbage-collected), or (b) the account is the wrapper-owned closed-market
 *   TOMBSTONE that CloseSlab leaves behind (see lib/closed-market-tombstone.ts: CloseSlab shrinks the
 *   slab to 16 bytes and keeps it, it never returns `null`). `tombstoned` is the (b) subset.
 * - `unresolved`: nothing can be concluded — the chunk failed, the address is not a pubkey, the
 *   reply was short, or the account exists but is not a readable slab.
 *
 * Only `missing` may hide a market; `unresolved` keeps the fail-open "degrade, don't hide" policy.
 */
export interface SlabResolution {
  missing: Set<string>;
  unresolved: Set<string>;
  /** Subset of `missing` that is a closed-market tombstone rather than an absent account. */
  tombstoned: Set<string>;
}

export interface LiveMarketReadResult extends SlabResolution {
  states: Map<string, LiveMarketState>;
}

type AccountProbe = { slab: string; key: PublicKey };
type ProbedAccount = { data?: Uint8Array | null; owner?: PublicKey | null };

/** Rejects if `p` has not settled within `ms` (no timer when `ms` is undefined). */
function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return p;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`slab probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Existence probe budget per chunk; the registered-markets feed must not hang on a slow RPC. */
export const SLAB_PROBE_TIMEOUT_MS = 4_000;

/** What `onExisting` concluded about a non-null account. */
type ExistingVerdict = true | false | "tombstone";

/**
 * Batched getMultipleAccountsInfo with existence provenance. `onExisting` handles each non-null
 * account: true = readable and alive, false = cannot be classified (→ unresolved), "tombstone" =
 * the wrapper's closed-market marker (→ confirmed dead, reported in `missing` + `tombstoned`).
 *
 * WRONG-CLUSTER GUARD: a `null` only proves absence if the RPC is looking at the cluster that
 * holds our slabs. If not one requested account came back non-null (DEVNET_RPC_URL pointed at
 * another cluster, a node still catching up, ...), every `null` is reclassified as unresolved —
 * an RPC misconfiguration must never wipe the market list.
 */
async function resolveSlabAccounts(
  slabAddresses: string[],
  connection: Connection | undefined,
  dataSlice: { offset: number; length: number } | undefined,
  onExisting: (probe: AccountProbe, info: ProbedAccount) => ExistingVerdict,
  opts: { timeoutMs?: number; noRateLimitRetry?: boolean } = {},
): Promise<SlabResolution> {
  const missing = new Set<string>();
  const unresolved = new Set<string>();
  const tombstoned = new Set<string>();

  // Deduplicate; an invalid address is unresolved, never proof that an account is absent.
  const probes: AccountProbe[] = [];
  for (const slab of new Set(slabAddresses)) {
    try {
      probes.push({ slab, key: new PublicKey(slab) });
    } catch {
      unresolved.add(slab);
    }
  }
  if (probes.length === 0) return { missing, unresolved, tombstoned };

  const conn =
    connection ??
    getServerConnection("confirmed", opts.noRateLimitRetry ? { disableRetryOnRateLimit: true } : {});
  let sawExisting = false;

  for (let start = 0; start < probes.length; start += CHUNK) {
    const chunk = probes.slice(start, start + CHUNK);
    try {
      const keys = chunk.map((c) => c.key);
      const read = dataSlice
        ? conn.getMultipleAccountsInfo(keys, { dataSlice })
        : conn.getMultipleAccountsInfo(keys);
      // A timeout rejects into the catch below: the chunk is unresolved, never hidden.
      const infos = await withTimeout(read, opts.timeoutMs);
      // Walk the REQUESTED accounts: a short reply leaves the tail unresolved, not missing.
      chunk.forEach((probe, i) => {
        const info = i < infos.length ? infos[i] : undefined;
        if (info === null) {
          missing.add(probe.slab);
        } else if (info === undefined) {
          unresolved.add(probe.slab);
        } else {
          sawExisting = true;
          const verdict = onExisting(probe, info);
          if (verdict === "tombstone") {
            missing.add(probe.slab);
            tombstoned.add(probe.slab);
          } else if (!verdict) unresolved.add(probe.slab);
        }
      });
    } catch {
      // An RPC failure is no evidence about existence.
      for (const { slab } of chunk) unresolved.add(slab);
    }
  }

  if (!sawExisting && missing.size > 0) {
    for (const slab of missing) unresolved.add(slab);
    missing.clear();
  }
  return { missing, unresolved, tombstoned };
}

/**
 * Exact closed-market classification of an account the RPC returned. The tombstone must be owned by
 * the current wrapper (only a wrapper can write program data; this also rejects a lookalike under
 * another program).
 */
function classifyTombstone(data: Uint8Array | null | undefined, owner: PublicKey | null | undefined): boolean {
  if (!owner || !isAcceptedWrapper(owner.toBase58())) return false;
  return isClosedMarketTombstone(data);
}

/** Read live state while preserving account-resolution provenance. Never throws. */
export async function readLiveMarketStateResolutions(
  slabAddresses: string[],
  connection?: Connection,
): Promise<LiveMarketReadResult> {
  const states = new Map<string, LiveMarketState>();
  const { missing, unresolved, tombstoned } = await resolveSlabAccounts(
    slabAddresses,
    connection,
    undefined,
    ({ slab, key }, info) => {
      if (!info.data) return false;
      // CloseSlab leaves a 16-byte wrapper-owned tombstone, not a null account: confirmed dead.
      if (classifyTombstone(info.data, info.owner)) return "tombstone";
      const state = parseLiveState(new Uint8Array(info.data), key);
      // Exists but is not a readable v17 slab: unresolved, never "absent".
      if (!state) return false;
      states.set(slab, info.owner ? { ...state, owner: info.owner.toBase58() } : state);
      return true;
    },
  );
  return { states, missing, unresolved, tombstoned };
}

/**
 * Existence-only probe for callers that only need to know whether a slab is gone (the
 * registered-markets route). Same missing/unresolved/tombstoned semantics and wrong-cluster guard
 * as readLiveMarketStateResolutions, but asks for a 17-byte dataSlice, so it transfers ~17 bytes per
 * slab instead of ~25KB. Never throws.
 */
export async function readSlabExistence(
  slabAddresses: string[],
  connection?: Connection,
): Promise<SlabResolution> {
  // Slice 17 bytes (header + 1): a reply of exactly 16 bytes proves the account IS 16 bytes long,
  // which, with the exact header bytes and the wrapper owner, is the CloseSlab tombstone.
  return resolveSlabAccounts(
    slabAddresses,
    connection,
    { offset: 0, length: TOMBSTONE_PROBE_SLICE_LEN },
    (_probe, info) => (classifyTombstone(info.data, info.owner) ? "tombstone" : true),
    // This feed is polled constantly: bound each chunk and do not let web3.js back off on a 429.
    // Both end in `unresolved` (fail open), never `missing`.
    { timeoutMs: SLAB_PROBE_TIMEOUT_MS, noRateLimitRetry: true },
  );
}

/**
 * Map-only live-state read (the pre-GH#2988 contract). Never throws: a missing or unresolved slab
 * is simply absent and callers keep their registry values. Visibility decisions that must tell
 * confirmed absence from an RPC gap use readLiveMarketStateResolutions.
 */
export async function readLiveMarketStates(
  slabAddresses: string[],
  connection?: Connection,
): Promise<Map<string, LiveMarketState>> {
  return (await readLiveMarketStateResolutions(slabAddresses, connection)).states;
}
