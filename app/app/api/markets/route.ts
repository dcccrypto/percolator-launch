import { NextRequest, NextResponse } from "next/server";
// requireAuth removed from POST — on-chain admin verification is sufficient
import { Connection, PublicKey } from "@solana/web3.js";
import { parseHeader } from "@percolator/sdk";
import { getServiceClient } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import * as Sentry from "@sentry/nextjs";
import { isSaneMarketValue } from "@/lib/activeMarketFilter";

/**
 * Maximum valid funding rate in bps/slot (matches on-chain guard).
 * Raw DB values outside [-MAX, MAX] are garbage from uninitialized slabs.
 */
const FUNDING_RATE_BPS_MAX = 10_000;

/** Cap per-market USD contribution — prevents sentinel leakage ($10B > any real market). */
const MAX_PER_MARKET_USD = 10_000_000_000;

/**
 * Convert a raw on-chain token micro-unit amount to USD.
 * Returns null when the raw value is a sentinel/garbage or no price is available.
 * (#1160: expose a pre-computed USD field so API consumers don't have to divide by 10^decimals themselves)
 */
function rawToUsd(raw: number | null | undefined, decimals: number | null | undefined, priceUsd: number | null | undefined): number | null {
  if (!isSaneMarketValue(raw)) return null;
  const d = Math.min(Math.max(decimals ?? 6, 0), 18);
  const p = priceUsd ?? 0;
  if (p <= 0) return null;
  const usd = (raw! / 10 ** d) * p;
  return usd > MAX_PER_MARKET_USD ? null : usd;
}

/** Sanitize a numeric funding_rate from the DB view. Returns null for garbage values. */
function sanitizeFundingRate(v: number | null | undefined): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || Math.abs(v) > FUNDING_RATE_BPS_MAX) return null;
  return v;
}

/**
 * Maximum sane mark/last price in USD for API output.
 * Set at $1M — well above any real crypto price today (BTC ~$100K) but below
 * the unscaled admin-set test garbage values (e.g. $100M, $900M, $7.9T).
 * Note: Rust MAX_ORACLE_PRICE is $1B; this is a stricter display-layer guard. (#856)
 */
const MAX_SANE_PRICE_USD = 1_000_000; // $1M

/**
 * Sanitize a price field from the DB (USD float). Returns null for corrupt/garbage values.
 * Logs a Sentry warning when sanitization fires so we can track data quality. (#882)
 *
 * Fingerprinted per (field, slab) so repeated sanitizations from the same bad market
 * collapse into ONE Sentry issue rather than one event per API poll cycle (#PERC-801).
 *
 * Known causes of sanitization:
 *  - Admin-mode markets with on-chain authorityPriceE6 set to garbage/test values
 *    (e.g. value > MAX_SANE_PRICE_USD × 1e6 on-chain, e.g. GYpukkn94, 2Zta2EPRR)
 *  - HYPERP markets without oracle_markets entries — oracle-keeper can't crank them,
 *    stale/uninitialised lastEffectivePriceE6 leaks through StatsCollector
 *  Fix: seed oracle_markets table (migration 041) for HYPERP markets, or correct the
 *  admin oracle price via the admin UI (pushPrice action with correct price_e6).
 */
function sanitizePrice(v: number | null | undefined, field?: string, slabAddress?: string): number | null {
  if (v == null) return null;
  if (!Number.isFinite(v) || v <= 0 || v > MAX_SANE_PRICE_USD) {
    Sentry.captureMessage(
      `Price sanitization: ${field ?? "price"} nulled for slab ${slabAddress ?? "unknown"} (value=${v})`,
      {
        level: "warning",
        tags: { endpoint: "/api/markets", sanitization: "price", field: field ?? "price" },
        // Fingerprint collapses all events for the same bad (field, slab) pair into a
        // single Sentry issue instead of one event per poll cycle.
        fingerprint: ["price-sanitization", field ?? "price", slabAddress ?? "unknown"],
        extra: { rawValue: v, field, slabAddress, maxSanePriceUsd: MAX_SANE_PRICE_USD },
      },
    );
    return null;
  }
  return v;
}

// #868: Blocklist for markets with corrupt state or wrong oracle_authority (e.g. issue #837).
// Populated from BLOCKED_MARKET_ADDRESSES env var (comma-separated slab addresses).
// HARDCODED_BLOCKED_MARKETS provides a code-level safety net for known-bad markets
// so they are excluded even if the env var is not set in a deployment.
const HARDCODED_BLOCKED_MARKETS: ReadonlySet<string> = new Set([
  // issue #837: wrong oracle_authority (5Eb8PY personal wallet), hardcoded $1 price,
  // never timestamped — price manipulation risk on devnet.
  "HjBePQZnoZVftg9B52gyeuHGjBvt2f8FNCVP4FeoP3YT",
]);

const BLOCKED_MARKET_ADDRESSES: ReadonlySet<string> = new Set([
  ...HARDCODED_BLOCKED_MARKETS,
  ...(process.env.BLOCKED_MARKET_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

export const dynamic = "force-dynamic";

// GET /api/markets — list all active markets with stats
export async function GET() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("markets_with_stats")
      .select(
        "slab_address,mint_address,symbol,name,decimals,deployer,logo_url,max_leverage,trading_fee_bps," +
        "last_price,mark_price,volume_24h,trade_count_24h,open_interest_long,open_interest_short,total_open_interest," +
        "insurance_fund,insurance_balance,total_accounts,funding_rate,net_lp_pos,lp_sum_abs,c_tot," +
        "vault_balance,created_at,stats_updated_at,oracle_mode,dex_pool_address,mainnet_ca,oracle_authority"
      );

    if (error) {
      Sentry.captureException(error, {
        tags: { endpoint: "/api/markets", method: "GET" },
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Sanitize funding_rate: raw DB values from uninitialized slabs can be
    // garbage (e.g. 17733189824741436). Clamp to valid bps range. (#817)
    // Also: oracle_mode was not populated for markets created before migration 035.
    // Derive from oracle_authority: zero pubkey → pyth-pinned, else admin/hyperp.
    // Default to "admin" when unknown — safest assumption for old devnet markets.
    const ZERO_PUBKEY = "11111111111111111111111111111111";
    const sanitized = ((data ?? []) as unknown as Record<string, unknown>[])
      .filter((m) => !BLOCKED_MARKET_ADDRESSES.has(m.slab_address as string))
      .map((m) => {
      let oracle_mode = m.oracle_mode as string | null;
      if (!oracle_mode) {
        const auth = m.oracle_authority as string | null;
        if (auth && auth !== ZERO_PUBKEY) {
          oracle_mode = "admin";
        } else if (auth === ZERO_PUBKEY) {
          oracle_mode = "pyth";
        } else {
          oracle_mode = "admin"; // safe default
        }
      }
      // #1160: Compute a USD-denominated OI field so consumers don't need to divide
      // by 10^decimals manually. Derived from total_open_interest when sane, falls
      // back to open_interest_long + open_interest_short. Raw fields are preserved.
      const sanitizedPrice = sanitizePrice(m.last_price as number | null, "last_price", m.slab_address as string);
      const rawOi = isSaneMarketValue(m.total_open_interest as number | null)
        ? m.total_open_interest as number
        : (() => {
            const combined = (m.open_interest_long as number ?? 0) + (m.open_interest_short as number ?? 0);
            return isSaneMarketValue(combined) ? combined : null;
          })();
      const total_open_interest_usd = rawToUsd(rawOi, m.decimals as number | null, sanitizedPrice);

      return {
        ...m,
        oracle_mode,
        funding_rate: sanitizeFundingRate(m.funding_rate as number | null),
        // #856: Null out corrupt admin-set test prices (raw unscaled u64 values or billions/trillions).
        // Matches Rust MAX_ORACLE_PRICE = $1B USD ceiling.
        last_price: sanitizedPrice,
        mark_price: sanitizePrice(m.mark_price as number | null, "mark_price", m.slab_address as string),
        // #855: Apply same sanitization to index_price — same DB column type and
        // corruption vector as last_price/mark_price. Inconsistent sanitization
        // means a corrupt index price still reaches consumers.
        index_price: sanitizePrice(m.index_price as number | null, "index_price", m.slab_address as string),
        // #1160: Pre-converted OI in USD (null when price unavailable or value is a sentinel).
        // Raw open_interest_long / open_interest_short / total_open_interest remain
        // in the response for backward compatibility.
        total_open_interest_usd,
      };
    });

    // #1168: Include total count so API consumers can get market count without
    // fetching all records. Reflects post-filter count (blocked markets excluded).
    return NextResponse.json({ total: sanitized.length, markets: sanitized }, {
      headers: {
        "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets", method: "GET" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/markets — register a new market after deployment
// Auth: on-chain verification (deployer == slab admin) is the real gate.
// No API key required — the client calls this after successful on-chain deployment.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

  const {
    slab_address,
    mint_address,
    symbol,
    name,
    decimals,
    deployer,
    oracle_authority,
    initial_price_e6,
    max_leverage,
    trading_fee_bps,
    lp_collateral,
    matcher_context,
    logo_url,
    mainnet_ca,
    oracle_mode,
    dex_pool_address,
  } = body;

  if (!slab_address || !mint_address || !deployer) {
    return NextResponse.json(
      { error: "Missing required fields: slab_address, mint_address, deployer" },
      { status: 400 }
    );
  }

  // #813: Validate oracle_mode enum
  const VALID_ORACLE_MODES = ["pyth", "hyperp", "admin"] as const;
  type OracleMode = typeof VALID_ORACLE_MODES[number];
  const resolvedOracleMode: OracleMode = oracle_mode ?? "admin";
  if (!VALID_ORACLE_MODES.includes(resolvedOracleMode)) {
    return NextResponse.json(
      { error: `Invalid oracle_mode. Must be one of: ${VALID_ORACLE_MODES.join(", ")}` },
      { status: 400 }
    );
  }

  // #813: Validate dex_pool_address is a valid Solana pubkey (when provided)
  if (dex_pool_address) {
    try {
      new PublicKey(dex_pool_address);
    } catch {
      return NextResponse.json(
        { error: "Invalid dex_pool_address: must be a valid Solana public key" },
        { status: 400 }
      );
    }
  }

  // Verify slab account exists on-chain and is owned by our program
  try {
    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");
    const slabPubkey = new PublicKey(slab_address);
    const accountInfo = await connection.getAccountInfo(slabPubkey);
    if (!accountInfo) {
      return NextResponse.json({ error: "Slab account does not exist on-chain" }, { status: 400 });
    }
    const validPrograms = new Set<string>([cfg.programId]);
    const tiers = (cfg as Record<string, unknown>).programsBySlabTier as Record<string, string> | undefined;
    if (tiers) Object.values(tiers).forEach((id) => validPrograms.add(id));
    if (!validPrograms.has(accountInfo.owner.toBase58())) {
      return NextResponse.json({ error: "Slab account not owned by a known percolator program" }, { status: 400 });
    }

    // R2-S8: Verify deployer matches the on-chain admin
    try {
      const header = parseHeader(accountInfo.data);
      if (header.admin.toBase58() !== deployer) {
        return NextResponse.json(
          { error: "Deployer does not match slab admin" },
          { status: 403 },
        );
      }
    } catch {
      return NextResponse.json({ error: "Failed to parse slab header" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: "Failed to verify slab on-chain" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Insert market
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: market, error: marketError } = await (supabase
    .from("markets") as any)
    .insert({
      slab_address,
      mint_address,
      symbol: symbol || mint_address.slice(0, 4).toUpperCase(),
      name: name || `Token ${mint_address.slice(0, 8)}`,
      decimals: decimals || 6,
      deployer,
      oracle_authority: oracle_authority || deployer,
      initial_price_e6,
      max_leverage: max_leverage || 10,
      trading_fee_bps: trading_fee_bps || 10,
      lp_collateral,
      matcher_context,
      logo_url: logo_url || null,
      mainnet_ca: mainnet_ca || null,
      oracle_mode: resolvedOracleMode,
      dex_pool_address: dex_pool_address || null,
    })
    .select()
    .single();

  if (marketError) {
    return NextResponse.json({ error: marketError.message }, { status: 500 });
  }

  // Create initial stats row
  await (supabase.from("market_stats") as any).insert({
    slab_address,
    last_price: initial_price_e6 ? initial_price_e6 / 1_000_000 : null,
  });

  // PERC-465: Hot-register with oracle keeper service (server-to-server, non-fatal)
  if (mainnet_ca && process.env.KEEPER_REGISTER_SECRET) {
    try {
      const keeperRegisterUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? ""}/api/oracle-keeper/register`;
      await fetch(keeperRegisterUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-keeper-secret": process.env.KEEPER_REGISTER_SECRET,
        },
        body: JSON.stringify({ slabAddress: slab_address, mainnetCA: mainnet_ca }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {
      // Non-fatal — oracle keeper will discover via Supabase polling
    }
  }

    return NextResponse.json({ market }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets", method: "POST" },
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
