/**
 * GET /api/stake/pools
 *
 * Returns all initialized StakePool accounts from the percolator-stake
 * devnet program, enriched with market name/symbol from Supabase,
 * vault token balance from RPC, and trailing APR from insurance snapshots.
 *
 * Response shape matches the StakePool interface used on the /stake page.
 */

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { getRpcEndpoint } from "@/lib/config";
import { getStakeProgramId, deriveStakePool } from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { readRegisteredMarkets, type RegisteredMarket } from "@/lib/playground-registered-markets";
import { isBlockedSlab } from "@/lib/blocklist";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
import * as Sentry from "@sentry/nextjs";

// ── APR helpers ───────────────────────────────────────────────────────────────

/** Milliseconds per day */
const MS_PER_DAY = 86_400_000;

/** Row shape returned from `insurance_snapshots` (not yet in generated types). */
interface InsuranceSnapshotRow {
  slab: string;
  redemption_rate_e6: number;
  created_at: string | null;
}

/**
 * Compute trailing APR (%) for a set of slab addresses using the
 * `insurance_snapshots` table written by the indexer's InsuranceLPService.
 *
 * Strategy: for each slab find the oldest snapshot in the last 7 days and
 * the most-recent snapshot, then annualise the redemption-rate growth.
 * Falls back to the 30-day window if there is less than 1 day of 7d data.
 * Returns 0 when insufficient history exists.
 *
 * PERF-001: Batch all three snapshot queries in parallel (Promise.all) instead
 * of sequential awaits to reduce database round-trip latency from 3 → 1.
 *
 * Note: `insurance_snapshots` is not yet reflected in the generated Supabase
 * types, so we cast to `any` on the table name and cast the result rows.
 */
async function computeAprs(
  slabAddresses: string[],
  supabase: ReturnType<typeof getServiceClient>
): Promise<Record<string, number>> {
  if (slabAddresses.length === 0) return {};

  const now = Date.now();
  const since7d = new Date(now - 7 * MS_PER_DAY).toISOString();
  const since30d = new Date(now - 30 * MS_PER_DAY).toISOString();

  const db = supabase;

  // PERC-8195: filter by network so devnet/mainnet rows don't mix
  const networkFilter = getServerNetwork();

  // PERF-001: Batch all three queries in parallel instead of sequential awaits.
  // This reduces latency from 3 database round-trips to 1 (with all queries
  // executing concurrently). Each query uses .in(slab, slabAddresses) for batch efficiency.
  const [result7d, result30d, resultLatest] = await Promise.all([
    // Query 1: Oldest snapshot per slab within 7-day window
    db
      .from("insurance_snapshots")
      .select("slab, redemption_rate_e6, created_at")
      .in("slab", slabAddresses)
      .eq("network", networkFilter)
      .gte("created_at", since7d)
      .order("created_at", { ascending: true }),
    // Query 2: Oldest snapshot per slab within 30-day window (fallback)
    db
      .from("insurance_snapshots")
      .select("slab, redemption_rate_e6, created_at")
      .in("slab", slabAddresses)
      .eq("network", networkFilter)
      .gte("created_at", since30d)
      .order("created_at", { ascending: true }),
    // Query 3: Latest snapshot per slab (current rate)
    // Limit to slabAddresses.length * 10 rows to bound result size
    // (slab list is on-chain so not user-controlled, but avoids latency spikes)
    db
      .from("insurance_snapshots")
      .select("slab, redemption_rate_e6, created_at")
      .in("slab", slabAddresses)
      .eq("network", networkFilter)
      .order("created_at", { ascending: false })
      .limit(slabAddresses.length * 10),
  ]);

  // Handle network column fallback for all three queries in parallel
  const networkFallbackPromises: PromiseLike<{ data: InsuranceSnapshotRow[] | null }>[] = [];
  
  if (result7d.error && result7d.error.message?.includes("network")) {
    networkFallbackPromises.push(
      db
        .from("insurance_snapshots")
        .select("slab, redemption_rate_e6, created_at")
        .in("slab", slabAddresses)
        .gte("created_at", since7d)
        .order("created_at", { ascending: true })
    );
  } else {
    networkFallbackPromises.push(Promise.resolve({ data: result7d.data }));
  }

  if (result30d.error && result30d.error.message?.includes("network")) {
    networkFallbackPromises.push(
      db
        .from("insurance_snapshots")
        .select("slab, redemption_rate_e6, created_at")
        .in("slab", slabAddresses)
        .gte("created_at", since30d)
        .order("created_at", { ascending: true })
    );
  } else {
    networkFallbackPromises.push(Promise.resolve({ data: result30d.data }));
  }

  if (resultLatest.error && resultLatest.error.message?.includes("network")) {
    console.warn(
      "[/api/stake/pools] PERC-8256: network column missing on insurance_snapshots — falling back to unfiltered query. " +
      "Apply 20260329180000_add_network_column.sql to fix."
    );
    networkFallbackPromises.push(
      db
        .from("insurance_snapshots")
        .select("slab, redemption_rate_e6, created_at")
        .in("slab", slabAddresses)
        .order("created_at", { ascending: false })
        .limit(slabAddresses.length * 10)
    );
  } else {
    networkFallbackPromises.push(Promise.resolve({ data: resultLatest.data }));
  }

  // Resolve all fallback queries in parallel
  const [fallback7d, fallback30d, fallbackLatest] = await Promise.all(
    networkFallbackPromises
  );

  const earliest7dRaw = result7d.data ?? fallback7d.data;
  const earliest30dRaw = result30d.data ?? fallback30d.data;
  const latestRaw = resultLatest.data ?? fallbackLatest.data;

  const earliest7d: InsuranceSnapshotRow[] = earliest7dRaw ?? [];
  const earliest30d: InsuranceSnapshotRow[] = earliest30dRaw ?? [];
  const latest: InsuranceSnapshotRow[] = latestRaw ?? [];

  // Build lookup maps: slab → first record in window
  const earliest7dBySlab = new Map<string, { rate: number; ts: number }>();
  const earliest30dBySlab = new Map<string, { rate: number; ts: number }>();
  const latestBySlab = new Map<string, { rate: number; ts: number }>();

  for (const row of earliest7d) {
    if (!earliest7dBySlab.has(row.slab)) {
      earliest7dBySlab.set(row.slab, {
        rate: Number(row.redemption_rate_e6),
        ts: new Date(row.created_at ?? 0).getTime(),
      });
    }
  }
  for (const row of earliest30d) {
    if (!earliest30dBySlab.has(row.slab)) {
      earliest30dBySlab.set(row.slab, {
        rate: Number(row.redemption_rate_e6),
        ts: new Date(row.created_at ?? 0).getTime(),
      });
    }
  }
  for (const row of latest) {
    if (!latestBySlab.has(row.slab)) {
      latestBySlab.set(row.slab, {
        rate: Number(row.redemption_rate_e6),
        ts: new Date(row.created_at ?? 0).getTime(),
      });
    }
  }

  const result: Record<string, number> = {};

  for (const slab of slabAddresses) {
    const cur = latestBySlab.get(slab);
    if (!cur || cur.rate === 0) {
      result[slab] = 0;
      continue;
    }

    // Try 7-day window first, fall back to 30-day
    const old = earliest7dBySlab.get(slab) ?? earliest30dBySlab.get(slab);
    if (!old || old.rate === 0) {
      result[slab] = 0;
      continue;
    }

    const elapsed = cur.ts - old.ts;
    if (elapsed < MS_PER_DAY) {
      // Not enough history yet
      result[slab] = 0;
      continue;
    }

    const periods = (365 * MS_PER_DAY) / elapsed;
    const compounded = Math.pow(cur.rate / old.rate, periods) - 1;

    // Clamp to 0: negative APY (insurance drawdown) would confuse stakers.
    result[slab] = isFinite(compounded)
      ? Math.max(0, Math.round(compounded * 10_000) / 100)  // → percentage, 2dp, floor 0
      : 0;
  }

  return result;
}

export const dynamic = "force-dynamic";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Expected on-chain size of a StakePool account (must match Rust struct).
 * The deployed v17 devnet stake program (51CeUNpb…) uses 352-byte pool accounts.
 * Using 384 caused getProgramAccounts to filter by the wrong dataSize and return
 * 0 results, so /stake and the stake side of /earn showed no pools.
 */
const STAKE_POOL_SIZE = 352;

// ── Binary layout helpers ─────────────────────────────────────────────────────

function readPubkey(data: Buffer, offset: number): string {
  // Base58-encode 32 bytes
  const bytes = data.subarray(offset, offset + 32);
  return new PublicKey(bytes).toBase58();
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

interface ParsedStakePool {
  isInitialized: boolean;
  bump: number;
  vaultAuthBump: number;
  adminTransferred: boolean;
  slab: string;
  admin: string;
  collateralMint: string;
  lpMint: string;
  vault: string;
  totalDeposited: bigint;
  totalLpSupply: bigint;
  cooldownSlots: bigint;
  depositCap: bigint;
  totalFlushed: bigint;
  totalReturned: bigint;
  totalWithdrawn: bigint;
  percolatorProgram: string;
  totalFeesEarned: bigint;
  poolMode: number;
}

/**
 * Parse the raw 352-byte StakePool account data (deployed v17 devnet layout).
 *
 * Rust layout (repr(C), #[derive(Pod)]):
 *   0:  is_initialized u8
 *   1:  bump           u8
 *   2:  vault_auth_bump u8
 *   3:  admin_transferred u8
 *   4-7: _padding [u8; 4]
 *   8-39:  slab           [u8; 32]
 *  40-71:  admin          [u8; 32]
 *  72-103: collateral_mint [u8; 32]
 * 104-135: lp_mint        [u8; 32]
 * 136-167: vault          [u8; 32]
 * 168:    total_deposited u64
 * 176:    total_lp_supply u64
 * 184:    cooldown_slots  u64
 * 192:    deposit_cap     u64
 * 200:    total_flushed   u64
 * 208:    total_returned  u64
 * 216:    total_withdrawn u64
 * 224-255: percolator_program [u8; 32]
 * 256:    total_fees_earned u64
 * 264:    last_fee_accrual_slot u64
 * 272:    last_vault_snapshot  u64
 * 280:    pool_mode       u8
 * 281-287: _mode_padding  [u8; 7]
 * 288-351: _reserved      [u8; 64]
 *
 * Note: this parser reads no field past offset 280, so it is forward-compatible
 * with any future reserved-tail additions.
 */
function parseStakePool(data: Buffer): ParsedStakePool | null {
  if (data.length < STAKE_POOL_SIZE) return null;
  const isInitialized = data[0] === 1;
  if (!isInitialized) return null;

  return {
    isInitialized,
    bump: data[1],
    vaultAuthBump: data[2],
    adminTransferred: data[3] === 1,
    slab: readPubkey(data, 8),
    admin: readPubkey(data, 40),
    collateralMint: readPubkey(data, 72),
    lpMint: readPubkey(data, 104),
    vault: readPubkey(data, 136),
    totalDeposited: readU64(data, 168),
    totalLpSupply: readU64(data, 176),
    cooldownSlots: readU64(data, 184),
    depositCap: readU64(data, 192),
    totalFlushed: readU64(data, 200),
    totalReturned: readU64(data, 208),
    totalWithdrawn: readU64(data, 216),
    percolatorProgram: readPubkey(data, 224),
    totalFeesEarned: readU64(data, 256),
    poolMode: data[280],
  };
}

/** Pool value in base units: deposited - withdrawn - flushed + returned + fees (trading LP only). */
function calcPoolValue(p: ParsedStakePool): bigint {
  const base =
    p.totalDeposited - p.totalWithdrawn - p.totalFlushed + p.totalReturned;
  return p.poolMode === 1 ? base + p.totalFeesEarned : base;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET() {
  try {
    // Resolve stake program: devnet v17 vault program, else mainnet stake program.
    const net = process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim();
    const isDevnet = net === "devnet";
    let stakeProgramId: PublicKey;
    try {
      // v17 devnet: stake/vault program is GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3
      // mainnet: DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F
      const programIdStr = isDevnet
        ? (process.env.STAKE_PROGRAM_ID ?? "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3")
        : "DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F";
      stakeProgramId = new PublicKey(programIdStr);
    } catch {
      return NextResponse.json({ pools: [] }, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      });
    }

    const connection = new Connection(getRpcEndpoint(), "confirmed");

    // 1. Fetch all on-chain StakePool accounts
    const rawAccounts = await connection.getProgramAccounts(stakeProgramId, {
      filters: [{ dataSize: STAKE_POOL_SIZE }],
    });

    if (rawAccounts.length === 0) {
      return NextResponse.json({ pools: [] }, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      });
    }

    // 2. Parse binary data
    const allParsed: Array<{ pubkey: string; pool: ParsedStakePool }> = [];
    for (const { pubkey, account } of rawAccounts) {
      const pool = parseStakePool(Buffer.from(account.data));
      if (pool) allParsed.push({ pubkey: pubkey.toBase58(), pool });
    }

    // 2a. Playground devnet: restrict to the 5 curated markets' stake pools PLUS
    // any user-launched markets registered via the create-market wizard.
    // getProgramAccounts(dataSize=352) returns EVERY StakePool this program owns,
    // which on a shared devnet deployment includes pools from older/unrelated test
    // markets. Derive the expected pool PDA for each known slab (curated seeds ∪
    // registered markets — not read from account data, the PDA derivation itself
    // is the trust anchor) and intersect by pool address, so only known-good pools
    // ever render. Mainnet has no curated-list concept, so this only applies on devnet.
    //
    // The registration Blob is read once here (not per-pool) — the same result also
    // backfills name/symbol below (step 5) for launched markets not yet in Supabase.
    let registeredMarkets: RegisteredMarket[] = [];
    if (isDevnet) {
      try {
        registeredMarkets = await readRegisteredMarkets();
      } catch (regErr) {
        // Never let a registry read failure take down /stake — degrade to
        // curated-5-only, same as before this feature existed.
        console.warn(
          "[/api/stake/pools] readRegisteredMarkets failed (non-fatal):",
          regErr instanceof Error ? regErr.message : String(regErr)
        );
      }
    }
    const registeredBySlab = new Map(registeredMarkets.map((m) => [m.slabAddress, m]));

    const curatedFiltered = isDevnet
      ? (() => {
          // Union: the 5 curated seeds ∪ every slab from the registration Blob
          // (user-created markets). A Set dedups automatically.
          const knownSlabs = new Set<string>([
            ...Object.keys(PLAYGROUND_SLAB_META),
            ...registeredBySlab.keys(),
          ]);

          const curatedPoolAddresses = new Set<string>();
          for (const slab of knownSlabs) {
            try {
              curatedPoolAddresses.add(
                deriveStakePool(new PublicKey(slab), stakeProgramId)[0].toBase58()
              );
            } catch {
              // Malformed slab address (shouldn't happen — registry entries are
              // verified on-chain at registration time) — skip rather than 500.
            }
          }
          return allParsed.filter((p) => curatedPoolAddresses.has(p.pubkey));
        })()
      : allParsed;

    // 2b. Filter out orphan pools whose slab no longer exists on-chain, plus any
    // blocklisted slab (e.g. ANSEM — hidden from the whole app via lib/blocklist).
    // H: curated(6) ∪ blob-registered(<=100) slabs can reach ~106 — chunked to
    // stay under the 100-key getMultipleAccountsInfo cap (see lib/rpc-chunk.ts).
    const slabKeys = curatedFiltered.map(p => new PublicKey(p.pool.slab));
    const slabInfos = await getMultipleAccountsInfoChunked(connection, slabKeys);
    const parsed = curatedFiltered.filter(
      (p, i) => slabInfos[i] !== null && !isBlockedSlab(p.pool.slab),
    );

    // 3. Fetch vault token balances (SPL token amount in each vault)
    const vaultAddresses = parsed.map((p) => p.pool.vault);
    const vaultInfos = await getMultipleAccountsInfoChunked(
      connection,
      vaultAddresses.map((a) => new PublicKey(a))
    );

    const vaultBalances: Record<string, bigint> = {};
    for (let i = 0; i < vaultAddresses.length; i++) {
      const info = vaultInfos[i];
      if (info && info.data.length >= 72) {
        // SPL Token account: amount at offset 64 (u64 LE)
        const amount = Buffer.from(info.data).readBigUInt64LE(64);
        vaultBalances[vaultAddresses[i]] = amount;
      } else {
        vaultBalances[vaultAddresses[i]] = 0n;
      }
    }

    // 4. Cross-reference slab addresses with Supabase market data + APR (guarded)
    const slabAddresses = parsed.map((p) => p.pool.slab);
    type _MarketRow = { slab_address: string | null; symbol: string; name: string; logo_url: string | null; insurance_balance: number | null; vault_balance: number | null };
    let markets: _MarketRow[] | null = null;
    let aprBySlab: Record<string, number> = {};

    let supabase: ReturnType<typeof getServiceClient> | null = null;
    try {
      supabase = getServiceClient();
    } catch {
      // Supabase unavailable — return pools with empty market metadata
    }

    if (supabase) {
      try {
        const [marketsResult, aprResult] = await Promise.all([
          supabase
            .from("markets_with_stats")
            .select("slab_address,symbol,name,logo_url,insurance_balance,vault_balance")
            .in("slab_address", slabAddresses)
            .eq("network", getServerNetwork()),
          computeAprs(slabAddresses, supabase),
        ]);

        let marketsData = marketsResult.data;
        if (marketsResult.error && marketsResult.error.message?.includes("network")) {
          const fallback = await supabase
            .from("markets_with_stats")
            .select("slab_address,symbol,name,logo_url,insurance_balance,vault_balance")
            .in("slab_address", slabAddresses);
          marketsData = fallback.data;
        }
        markets = marketsData as _MarketRow[] | null;
        aprBySlab = aprResult;
      } catch (sbErr) {
        console.warn("[/api/stake/pools] supabase query failed (non-fatal):", sbErr instanceof Error ? sbErr.message : String(sbErr));
      }
    }

    const marketBySlab: Record<string, {
      symbol: string;
      name: string;
      logo_url: string | null;
      insurance_balance: number | null;
      vault_balance: number | null;
    }> = {};
    if (markets) {
      for (const m of markets) {
        if (m.slab_address) {
          marketBySlab[m.slab_address] = m as typeof marketBySlab[string];
        }
      }
    }

    // 5. Build response
    // Collateral decimals: we assume USDC (6 dec) unless we can detect otherwise.
    // The full-precision bigint values are returned so the client can format correctly.
    const USDC_DECIMALS = 6;
    const toUsdcFloat = (raw: bigint) =>
      Number(raw) / Math.pow(10, USDC_DECIMALS);

    const pools = parsed.map(({ pubkey, pool }) => {
      const market = marketBySlab[pool.slab];
      const vaultBalRaw = vaultBalances[pool.vault] ?? 0n;
      const poolValueRaw = calcPoolValue(pool);

      // APR: trailing annualised rate from insurance_snapshots (7d or 30d window).
      // Falls back to 0 when fewer than 1 day of snapshots exist.
      const apr = aprBySlab[pool.slab] ?? 0;

      const capUsedRaw = vaultBalRaw; // real deposits in vault
      const capTotalRaw = pool.depositCap > 0n ? pool.depositCap : 0n; // 0 = uncapped

      return {
        /** Pool PDA address */
        poolAddress: pubkey,
        /** Slab (market) address */
        slabAddress: pool.slab,
        /** Collateral mint */
        collateralMint: pool.collateralMint,
        /** LP mint */
        lpMint: pool.lpMint,
        /** Vault token account */
        vault: pool.vault,
        /** Market info: Supabase first, then curated playground metadata, then the
         *  registration Blob (user-launched markets), then slab-prefix last resort. */
        name:
          market?.name ??
          PLAYGROUND_SLAB_META[pool.slab]?.name ??
          registeredBySlab.get(pool.slab)?.label ??
          `Pool ${pool.slab.slice(0, 8)}`,
        symbol:
          market?.symbol ??
          PLAYGROUND_SLAB_META[pool.slab]?.symbol ??
          registeredBySlab.get(pool.slab)?.symbol ??
          pool.slab.slice(0, 8),
        logoUrl: market?.logo_url ?? null,
        /** TVL = vault balance in USDC */
        tvl: toUsdcFloat(vaultBalRaw),
        /** TVL in raw token units (6 dec for USDC) */
        tvlRaw: vaultBalRaw.toString(),
        /** Pool value (deposited - withdrawn - flushed + returned) */
        poolValue: toUsdcFloat(poolValueRaw),
        /** Trailing APR % from insurance_snapshots redemption-rate growth (7d/30d window) */
        apr,
        /** Deposit cap in USDC (0 = uncapped) */
        capTotal: toUsdcFloat(capTotalRaw),
        capTotalRaw: capTotalRaw.toString(),
        /** Cap used = vault balance (current deposits) */
        capUsed: toUsdcFloat(capUsedRaw),
        capUsedRaw: capUsedRaw.toString(),
        /** Cooldown in slots */
        cooldownSlots: Number(pool.cooldownSlots),
        /** Total LP supply */
        totalLpSupply: Number(pool.totalLpSupply),
        /** Vault balance (same as tvl in raw units) */
        vaultBalance: toUsdcFloat(vaultBalRaw),
        /** Pool mode: 0 = insurance LP, 1 = trading LP */
        poolMode: pool.poolMode,
        /** Whether admin has been transferred to PDA (fully decentralised) */
        adminTransferred: pool.adminTransferred,
      };
    });

    return NextResponse.json({ pools }, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/stake/pools" } });
    console.error("[/api/stake/pools]", err);
    return NextResponse.json(
      { error: "Failed to fetch stake pools", pools: [] },
      { status: 500 }
    );
  }
}
