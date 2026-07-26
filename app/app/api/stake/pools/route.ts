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
import { getStakeProgramId, deriveStakePool, STAKE_POOL_SIZE } from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { readRegisteredMarkets, type RegisteredMarket } from "@/lib/playground-registered-markets";
import { isBlockedSlab } from "@/lib/blocklist";
import { getMultipleAccountsInfoChunked } from "@/lib/rpc-chunk";
import * as Sentry from "@sentry/nextjs";

// ── APR helpers ───────────────────────────────────────────────────────────────

/**
 * Compute trailing APR (%) for a set of slab addresses.
 *
 * REDUCED SCHEMA (2026-07): the indexer was cut down to history-only and the
 * `insurance_snapshots` table (previously written by the indexer's
 * InsuranceLPService) was dropped from the new Supabase project — querying it
 * would 500. There is no longer a redemption-rate history to annualise, so
 * this always returns 0 for every slab (graceful degrade, matches the
 * pre-existing "insufficient history" 0% path below). The `supabase` param is
 * kept so callers don't need to change; it is intentionally unused now.
 */
async function computeAprs(
  slabAddresses: string[],
  _supabase: ReturnType<typeof getServiceClient>
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const slab of slabAddresses) result[slab] = 0;
  return result;
}

export const dynamic = "force-dynamic";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Expected on-chain size of a StakePool account — imported from the SDK
 * (`STAKE_POOL_SIZE`) so it tracks the deployed Rust struct instead of a
 * hand-copied literal.
 *
 * CUTOVER (2026-07): the FRESH devnet stake program
 * (GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3) deploys 392-byte pool accounts
 * (the v2 layout: adds pendingAdmin / HWM / tranche fields after `pool_mode`).
 * The retired program (51CeUNpb…) used 352-byte accounts. This route previously
 * hardcoded 352, so `getProgramAccounts({ filters: [{ dataSize: 352 }] })`
 * matched ZERO real pools on the new program and /stake + the stake side of
 * /earn showed no pools. `parseStakePool` below reads no field past offset 280,
 * which is byte-identical between the two layouts, so it stays correct for both.
 */

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
 * Parse a raw StakePool account (deployed v17 devnet layout, 392 bytes on the
 * fresh GCHhcgw… program; reads no field past offset 280, which is identical
 * on the retired 352-byte program).
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
    // REDUCED SCHEMA (2026-07): insurance_balance/vault_balance no longer exist on
    // markets_with_stats (dropped market_stats columns) — dropped from this row
    // shape. Neither was ever read downstream; TVL/vault come from the on-chain
    // RPC token-balance read a few lines below instead.
    type _MarketRow = { slab_address: string | null; symbol: string; name: string; logo_url: string | null };
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
            .select("slab_address,symbol,name,logo_url")
            .in("slab_address", slabAddresses)
            .eq("network", getServerNetwork()),
          computeAprs(slabAddresses, supabase),
        ]);

        let marketsData = marketsResult.data;
        if (marketsResult.error && marketsResult.error.message?.includes("network")) {
          const fallback = await supabase
            .from("markets_with_stats")
            .select("slab_address,symbol,name,logo_url")
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

      // APR: was a trailing annualised rate from insurance_snapshots (7d/30d
      // window) — that table is gone (REDUCED SCHEMA 2026-07), so computeAprs()
      // always returns 0 now. See its doc comment above.
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
        /** Trailing APR % — always 0 now; insurance_snapshots history was dropped (see computeAprs) */
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
