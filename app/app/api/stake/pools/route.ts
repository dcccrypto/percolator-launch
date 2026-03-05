/**
 * GET /api/stake/pools
 *
 * Returns all initialized StakePool accounts from the percolator-stake
 * devnet program, enriched with market name/symbol from Supabase and
 * vault token balance from RPC.
 *
 * Response shape matches the StakePool interface used on the /stake page.
 */

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getServiceClient } from "@/lib/supabase";
import { getRpcEndpoint } from "@/lib/config";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// ── Constants ────────────────────────────────────────────────────────────────

/** Percolator Stake program (devnet). */
const STAKE_PROGRAM_ID = new PublicKey(
  "6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k"
);

/** Expected on-chain size of a StakePool account (must match Rust struct). */
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
 * Parse the raw 352-byte StakePool account data.
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
    const connection = new Connection(getRpcEndpoint(), "confirmed");

    // 1. Fetch all on-chain StakePool accounts
    const rawAccounts = await connection.getProgramAccounts(STAKE_PROGRAM_ID, {
      filters: [{ dataSize: STAKE_POOL_SIZE }],
    });

    if (rawAccounts.length === 0) {
      return NextResponse.json({ pools: [] }, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
      });
    }

    // 2. Parse binary data
    const parsed: Array<{ pubkey: string; pool: ParsedStakePool }> = [];
    for (const { pubkey, account } of rawAccounts) {
      const pool = parseStakePool(Buffer.from(account.data));
      if (pool) parsed.push({ pubkey: pubkey.toBase58(), pool });
    }

    // 3. Fetch vault token balances (SPL token amount in each vault)
    const vaultAddresses = parsed.map((p) => p.pool.vault);
    const vaultInfos = await connection.getMultipleAccountsInfo(
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

    // 4. Cross-reference slab addresses with Supabase market data
    const slabAddresses = parsed.map((p) => p.pool.slab);
    const supabase = getServiceClient();
    const { data: markets } = await supabase
      .from("markets_with_stats")
      .select("slab_address,symbol,name,logo_url,insurance_balance,vault_balance")
      .in("slab_address", slabAddresses);

    const marketBySlab: Record<string, {
      symbol: string;
      name: string;
      logo_url: string | null;
      insurance_balance: number | null;
      vault_balance: number | null;
    }> = {};
    for (const m of markets ?? []) {
      if (m.slab_address) {
        marketBySlab[m.slab_address] = m as typeof marketBySlab[string];
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

      // APR: use insurance_balance growth proxy when available; 0 otherwise.
      // TODO: compute real APR from fee accrual history.
      const apr = 0;

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
        /** Market info (null if slab not in Supabase) */
        name: market?.name ?? `Pool ${pool.slab.slice(0, 8)}`,
        symbol: market?.symbol ?? pool.slab.slice(0, 8),
        logoUrl: market?.logo_url ?? null,
        /** TVL = vault balance in USDC */
        tvl: toUsdcFloat(vaultBalRaw),
        /** TVL in raw token units (6 dec for USDC) */
        tvlRaw: vaultBalRaw.toString(),
        /** Pool value (deposited - withdrawn - flushed + returned) */
        poolValue: toUsdcFloat(poolValueRaw),
        /** APR (0 until fee history is indexed) */
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
