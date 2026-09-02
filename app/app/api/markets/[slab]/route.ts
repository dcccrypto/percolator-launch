import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { validateSlabParam } from "@/lib/route-validators";
import { SLUG_ALIASES } from "@/lib/symbol-utils";
import { isBlockedSlab } from "@/lib/blocklist";
import * as Sentry from "@sentry/nextjs";
import {
  parseWrapperConfigV17,
  parseMarketGroupV17OI,
  isV17Account,
  V17_HEADER_LEN,
} from "@percolatorct/sdk";
import { getConfig, getRpcEndpoint } from "@/lib/config";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { readCreatorFeeClaimable } from "@/lib/v17-creator-fee";
import { readRegisteredMarkets } from "@/lib/playground-registered-markets";
import { getMarketLpCapital } from "@/lib/lp-portfolio";
import { verifyKeeperSignature } from "@/lib/keeper-hmac";
import { sanitizeLogoUrl } from "@/lib/token-metadata-validators";

/**
 * GH#2334 follow-up: `vault_balance`/`c_tot` are NULL for every v17 market in
 * the Supabase view (the v12 stats collector never ran against v17), so
 * "Market LP" rendered as "—" everywhere. When both are null, read the real
 * LP-portfolio `capital` on-chain (known address fast path for curated seeds,
 * getProgramAccounts scan otherwise — see lib/lp-portfolio.ts) and use it as
 * the displayed vault_balance. Never throws — degrades to the original null
 * ("—") on any RPC failure.
 */
async function withOnChainMarketLp(
  market: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hasVault = market.vault_balance != null && Number.isFinite(Number(market.vault_balance));
  const hasCtot = market.c_tot != null && Number.isFinite(Number(market.c_tot));
  if (hasVault || hasCtot) return market;

  const slab = market.slab_address as string | undefined;
  if (!slab) return market;

  try {
    const programId = new PublicKey(getConfig().programId as string);
    const rpcUrl = getRpcEndpoint();
    const connection = new Connection(rpcUrl, "confirmed");
    const capital = await getMarketLpCapital(connection, programId, slab);
    if (capital != null) {
      return { ...market, vault_balance: Number(capital) };
    }
  } catch {
    // Degrade to the original null — the UI already renders that as "—".
  }
  return market;
}

/** Success responses only — matches GET /api/markets (errors omit this to avoid caching 404/500). */
const MARKETS_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60",
} as const;

/**
 * On-chain fallback: fetch the slab account directly and parse it.
 * Used when Supabase is not configured (e.g. devnet playground).
 * Uses a single getAccountInfo call — fast (~100ms) and sufficient.
 *
 * Returns 404 when the slab doesn't exist or isn't a recognised v17 account.
 */
async function onChainSlabFallback(slab: string): Promise<NextResponse> {
  try {
    const slabPk = new PublicKey(slab);
    const rpcUrl = getRpcEndpoint();
    const connection = new Connection(rpcUrl, "confirmed");
    const info = await connection.getAccountInfo(slabPk);

    if (!info) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const data = new Uint8Array(info.data);
    if (!isV17Account(data)) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
    const markPriceRaw = cfg.markEwmaE6;
    const markPriceUsd = markPriceRaw > 0n ? Number(markPriceRaw) / 1_000_000 : null;
    // Creator fee claim (tag 90): the accrued balance + the wallet that may claim
    // it (asset 0's asset_admin). Surfaced so My Markets can show creators their
    // claimable fees without a separate on-chain read. Cheap — reuses `data`.
    const creatorFee = readCreatorFeeClaimable(data);
    const playgroundMeta = PLAYGROUND_SLAB_META[slab];
    // Wizard-launched markets carry their metadata in the registration Blob —
    // without this lookup the trade page header falls back to the collateral
    // token and renders every user-created market as "USDC/USD".
    const registered = playgroundMeta
      ? null
      : (await readRegisteredMarkets().catch(() => []))
          .find((rm) => rm.slabAddress === slab) ?? null;

    // Live engine stats from the same raw bytes (mirrors the list route's
    // v17 enrichment). Degrades to zeros if the parse throws.
    let oiLong = 0, oiShort = 0, insurance = 0;
    try {
      const oi = parseMarketGroupV17OI(data);
      oiLong = Number(oi.totalLongOiQ);
      oiShort = Number(oi.totalShortOiQ);
      insurance = Number(oi.insuranceBalance);
    } catch { /* stats stay zeroed */ }

    const market = {
      slab_address: slab,
      program_id: info.owner.toBase58(),
      mint_address: cfg.collateralMint.toBase58(),
      symbol: playgroundMeta?.symbol ?? registered?.symbol ?? null,
      name: playgroundMeta?.name ?? registered?.label ?? null,
      decimals: 6,
      deployer: cfg.marketauth.toBase58(),
      oracle_authority: cfg.marketauth.toBase58(),
      // Match the list route: byte 3 = AUTH_MARK (keeper), byte 1 = hyperp.
      oracle_mode: cfg.oracleMode === 1 ? "hyperp" : cfg.oracleMode === 3 ? "keeper" : "admin",
      dex_pool_address: playgroundMeta?.dex_pool_address ?? registered?.poolAddress ?? null,
      mainnet_ca: playgroundMeta?.mainnet_ca ?? registered?.mainnetCA ?? null,
      created_at: null,
      stats_updated_at: null,
      is_zombie: false,
      last_price: markPriceUsd,
      mark_price: markPriceUsd,
      index_price: null,
      // Volume needs the trade-tape indexer — null ("no data"), NOT 0.
      // MarketInfoBar renders null as "—"; a hard $0 reads as "market is dead".
      volume_24h: null,
      trade_count_24h: 0,
      open_interest_long: oiLong,
      open_interest_short: oiShort,
      total_open_interest: oiLong + oiShort,
      total_open_interest_usd: markPriceUsd != null ? ((oiLong + oiShort) / 1_000_000) * markPriceUsd : 0,
      insurance_fund: insurance,
      insurance_balance: insurance,
      // Creator fee claim (tag 90). atoms as a string (u64 can exceed JS number
      // precision); authority is asset-0 asset_admin, the only wallet that can
      // claim. null when not a v17 market.
      creator_fee_claimable_atoms: creatorFee ? creatorFee.atoms.toString() : "0",
      creator_fee_authority: creatorFee?.claimAuthority?.toBase58() ?? null,
      total_accounts: 0,
      funding_rate: null,
      net_lp_pos: 0,
      lp_sum_abs: 0,
      // Unknown on v17 (no cheap on-chain source) — null, not 0, to avoid the
      // phantom-OI vault guard downstream (same rationale as the list route).
      c_tot: null,
      volume_24h_usd: null,
      vault_balance: null,
    };

    // Real Market-LP on-chain (see withOnChainMarketLp doc comment above) —
    // this path already knows the wrapper program id from the fetched slab
    // account's owner, so reuse the same connection instead of re-deriving
    // getConfig().programId.
    let marketWithLp: Record<string, unknown> = market;
    try {
      const capital = await getMarketLpCapital(connection, info.owner, slab);
      if (capital != null) {
        marketWithLp = { ...market, vault_balance: Number(capital) };
      }
    } catch {
      // Degrade to the original null — the UI already renders that as "—".
    }

    return NextResponse.json(
      { market: marketWithLp },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60", "X-Percolator-Data-Source": "on-chain-direct" } },
    );
  } catch {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }
}

/**
 * GH#1405: Sanitize price fields from the DB. Returns null for corrupt/garbage values.
 * Matches the MAX_SANE_PRICE_USD guard in /api/markets route.ts ($1M ceiling).
 * Prevents raw unscaled admin oracle values (e.g. 10001100011 for DfLoAzny) from
 * being returned to callers of the individual slab endpoint.
 */
const MAX_SANE_PRICE_USD = 1_000_000; // $1M — matches bulk /api/markets guard
function sanitizePrice(v: unknown): number | null {
  if (v == null || typeof v !== "number") return null;
  if (!Number.isFinite(v) || v <= 0 || v > MAX_SANE_PRICE_USD) return null;
  return v;
}
export const dynamic = "force-dynamic";

function isValidPublicKey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/markets/[slab]
 * Accepts either a base58 slab address OR a market slug (e.g. "SOL-PERP", "SOL").
 * When a slug is given, resolves it by matching the `symbol` column (case-insensitive,
 * with optional "-PERP" suffix stripped).
 * 
 * MEDIUM-003: Added slab parameter validation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;

  // Validate slab parameter format (unless it's a slug like "SOL" or "SOL-PERP")
  // Slugs are 1-6 chars alphanumeric+dash; PublicKey addresses are 43-44 chars base58
  if (slab.length > 10) {
    const validation = validateSlabParam(slab);
    if (!validation.valid) {
      return validation.response;
    }
  }

  // GH#1417: Blocked slabs must return 404 even when addressed directly.
  // The bulk /api/markets endpoint already filters via BLOCKED_SLAB_ADDRESSES but
  // this individual endpoint had no guard, allowing blocked addresses (e.g. 8eFFEFBY)
  // to return HTTP 200 with phantom data.
  if (isBlockedSlab(slab)) {
    return NextResponse.json({ error: "Market not found" }, { status: 404 });
  }

  // Degrade gracefully when Supabase is not configured (e.g. devnet playground without DB).
  let supabaseClient: ReturnType<typeof getServiceClient>;
  try {
    supabaseClient = getServiceClient();
  } catch {
    // Supabase not configured — fall back to on-chain direct fetch.
    return await onChainSlabFallback(slab);
  }

  try {
    const supabase = supabaseClient;
    let data: Record<string, unknown> | null = null;

    // PERC-8195: filter by network so devnet/mainnet rows don't mix
    const network = getServerNetwork();

    if (isValidPublicKey(slab)) {
      // Standard lookup by slab address
      // PERC-8225: Graceful fallback — if the network column is missing (migration not yet
      // applied), retry without the filter to restore service. Mirrors the pattern in
      // /api/markets/route.ts (PERC-8215).
      let { data: row, error } = await supabase
        .from("markets_with_stats")
        .select("*")
        .eq("slab_address", slab)
        .eq("network", network)
        .maybeSingle();

      if (error && error.message?.includes("network")) {
        Sentry.captureMessage(
          "PERC-8225: markets_with_stats.network column missing in [slab] route — migration not applied. " +
          "Falling back to unfiltered query. Apply 20260329180000_add_network_column.sql to fix.",
          {
            level: "warning",
            tags: { endpoint: "/api/markets/[slab]", method: "GET", degraded: "true" },
            fingerprint: ["perc-8225-network-column-missing-slab"],
          }
        );
        const fallback = await supabase
          .from("markets_with_stats")
          .select("*")
          .eq("slab_address", slab)
          .maybeSingle();
        row = fallback.data;
        error = fallback.error;
      }

      if (error) {
        Sentry.captureException(error, {
          tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
        });
        return NextResponse.json({ error: "Failed to load market. Please try again later." }, { status: 500 });
      }
      data = row;
    } else {
      // Slug resolution: strip "-PERP" suffix and match symbol case-insensitively
      const slugNorm = slab.toUpperCase().replace(/-PERP$/, "");

      // Fetch all markets and filter in JS to avoid needing ilike + function indexes
      // PERC-8225: Graceful fallback — if the network column is missing (migration not yet
      // applied), retry without the filter to restore service. Mirrors the pattern in
      // /api/markets/route.ts (PERC-8215).
      let { data: rows, error } = await supabase
        .from("markets_with_stats")
        .select("*")
        .eq("network", network);

      if (error && error.message?.includes("network")) {
        Sentry.captureMessage(
          "PERC-8225: markets_with_stats.network column missing in [slab] slug route — migration not applied. " +
          "Falling back to unfiltered query. Apply 20260329180000_add_network_column.sql to fix.",
          {
            level: "warning",
            tags: { endpoint: "/api/markets/[slab]", method: "GET", degraded: "true", lookup: "slug" },
            fingerprint: ["perc-8225-network-column-missing-slug"],
          }
        );
        const fallback = await supabase
          .from("markets_with_stats")
          .select("*");
        rows = fallback.data;
        error = fallback.error;
      }

      if (error) {
        Sentry.captureException(error, {
          tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
        });
        return NextResponse.json({ error: "Failed to load market. Please try again later." }, { status: 500 });
      }

      // Sort to prefer the most active slab when multiple markets share the same
      // symbol / mint (e.g. 25 SOL devnet markets).
      // Rule: treat volume_24h=0 and volume_24h=null identically as "no volume" (-1)
      // so a dead slab with explicit vol=0 never beats a fresh slab with vol=null.
      // Tiebreakers: total_open_interest DESC, then created_at DESC (newest wins).
      const sorted = (rows ?? []).slice().sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const va = typeof a.volume_24h === "number" && (a.volume_24h as number) > 0 ? (a.volume_24h as number) : -1;
        const vb = typeof b.volume_24h === "number" && (b.volume_24h as number) > 0 ? (b.volume_24h as number) : -1;
        if (vb !== va) return vb - va;
        const oa = typeof a.total_open_interest === "number" && (a.total_open_interest as number) > 0 ? (a.total_open_interest as number) : -1;
        const ob = typeof b.total_open_interest === "number" && (b.total_open_interest as number) > 0 ? (b.total_open_interest as number) : -1;
        if (ob !== oa) return ob - oa;
        return new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime();
      });

      // 1. Try symbol match (e.g. DB symbol = "SOL-PERP")
      let match = sorted.find((m: Record<string, unknown>) => {
        const sym = String(m.symbol ?? "").toUpperCase().replace(/-PERP$/, "");
        return sym === slugNorm || String(m.symbol ?? "").toUpperCase() === slab.toUpperCase();
      });

      // 2. Fallback: well-known mint alias (e.g. SOL → So111...)
      if (!match) {
        const aliasMint = SLUG_ALIASES[slugNorm];
        if (aliasMint) {
          match = sorted.find((m: Record<string, unknown>) => m.mint_address === aliasMint);
        }
      }

      data = match ?? null;
    }

    if (!data) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    // GH#1444: Re-check blocklist after symbol/slug resolution.
    // The initial guard at the top only checks the raw URL param (e.g. "DfLoAzny"),
    // which may not be in the blocklist. After DB lookup, `data.slab_address` holds the
    // resolved on-chain address (e.g. "8eFFEFBY3...") which IS blocked. Without this
    // second check, symbol-addressed requests bypass the blocklist entirely.
    if (isBlockedSlab(String(data.slab_address ?? ""))) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    // GH#1405: Sanitize price fields before returning — raw DB values from admin-mode
    // markets may be unscaled u64 authorityPriceE6 values (e.g. DfLoAzny: 10001100011).
    // Matches the sanitizePrice guard in the bulk /api/markets endpoint.
    const sanitized = {
      ...data,
      last_price: sanitizePrice(data.last_price),
      mark_price: sanitizePrice(data.mark_price),
      index_price: sanitizePrice(data.index_price),
    };

    // GH#2334 follow-up: the Supabase view has no v17 vault_balance/c_tot data
    // (see withOnChainMarketLp doc comment) — read the real LP-portfolio
    // capital on-chain for the trade-page detail view when both are null.
    const withLp = await withOnChainMarketLp(sanitized);

    return NextResponse.json({ market: withLp }, { headers: MARKETS_CACHE_HEADERS });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets/[slab]", method: "GET", slab },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * PATCH /api/markets/[slab] — set a market's displayed identity.
 *
 * Why this exists: v17 admin-oracle markets carry NO on-chain pointer to what
 * they track (no Pyth indexFeedId, no DEX pool, no mainnet CA). The indexer
 * cannot name them — it writes a neutral "UNKNOWN" / "Market <prefix>"
 * placeholder — so a human supplies the real symbol, name, and logo here.
 *
 * Writing through this route flips `metadata_source` to 'manual', which the
 * indexer treats as off-limits: its registration path only ever INSERTs missing
 * slabs, so an edit made here is never overwritten by a later discovery cycle.
 *
 * Auth: the same HMAC-SHA256 scheme as /api/oracle-keeper/register — the shared
 * secret never crosses the wire, and the signed timestamp bounds replay. This is
 * an operator endpoint, not a user-facing one.
 *
 *   x-keeper-timestamp: <ms epoch>
 *   x-keeper-signature: hex HMAC-SHA256("<timestamp>.<rawBody>", KEEPER_REGISTER_SECRET)
 *
 * Body (every field optional; at least one required):
 *   { "symbol": "SOL", "name": "SOL/USDC Perpetual", "logo_url": "https://…" }
 *
 * `logo_url: null` explicitly clears the logo.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ slab: string }> },
) {
  const { slab } = await context.params;

  // PATCH targets a concrete market, so unlike GET it does not accept slug
  // aliases ("SOL") — always require a real slab address.
  const validation = validateSlabParam(slab);
  if (!validation.valid) {
    return validation.response;
  }

  const secret = process.env.KEEPER_REGISTER_SECRET;
  if (!secret) {
    // Fail closed: without a secret every request would otherwise be "authorized".
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  // Read the body ONCE as raw text — the HMAC covers the exact bytes sent, so it
  // must be verified before parsing, and re-reading the stream is not possible.
  const rawBody = await req.text();
  // #2476: bound to this method and path. `req.nextUrl.pathname` rather than a
  // literal, because this route is parameterised by slab — a literal would be
  // wrong, and reconstructing it would duplicate what the router already has.
  const signed = verifyKeeperSignature(
    secret,
    req.headers.get("x-keeper-timestamp"),
    rawBody,
    req.headers.get("x-keeper-signature"),
    { method: req.method, path: req.nextUrl.pathname },
    // Transition: this endpoint's signer is NOT in this repo — the keeper
    // service has no createHmac at all, so the caller is external and could
    // not be updated in the same commit. Accepting the legacy form keeps that
    // hop alive across the rollout and logs every use. Drop this argument once
    // the warnings stop. See #2476.
    true,
  );
  if (!signed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;

  // Build the patch from supplied keys only, so omitting a field leaves it alone
  // while `logo_url: null` deliberately clears it.
  const patch: Record<string, unknown> = {};

  if ("symbol" in input) {
    const symbol = typeof input.symbol === "string" ? input.symbol.trim() : "";
    if (symbol.length === 0 || symbol.length > 32) {
      return NextResponse.json({ error: "symbol must be 1-32 characters" }, { status: 400 });
    }
    // Same control-character/markup strip the indexer applies to DAS metadata —
    // this value is stored and rendered.
    patch.symbol = symbol.replace(/[\x00-\x1f\x7f<>]/g, "");
  }

  if ("name" in input) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0 || name.length > 128) {
      return NextResponse.json({ error: "name must be 1-128 characters" }, { status: 400 });
    }
    patch.name = name.replace(/[\x00-\x1f\x7f<>]/g, "");
  }

  if ("logo_url" in input) {
    if (input.logo_url === null) {
      patch.logo_url = null;
    } else {
      // Reuse the same allowlist the launch flow uses, so a URL accepted here
      // renders identically to one set at registration.
      const sanitized = sanitizeLogoUrl(input.logo_url);
      if (!sanitized) {
        return NextResponse.json(
          { error: "logo_url must be an https:// or ipfs:// URL, or null to clear" },
          { status: 400 },
        );
      }
      patch.logo_url = sanitized;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "Supply at least one of: symbol, name, logo_url" },
      { status: 400 },
    );
  }

  // Mark the row as human-authored so the indexer leaves it alone from now on.
  // updated_at is set by the markets_set_updated_at trigger, not here.
  patch.metadata_source = "manual";

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("markets")
      .update(patch)
      .eq("slab_address", slab)
      .eq("network", getServerNetwork())
      .select("slab_address,symbol,name,logo_url,metadata_source")
      .maybeSingle();

    if (error) {
      Sentry.captureException(error, {
        tags: { endpoint: "/api/markets/[slab]", method: "PATCH", slab },
      });
      return NextResponse.json({ error: "Update failed" }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "Market not found" }, { status: 404 });
    }

    return NextResponse.json({ market: data });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/markets/[slab]", method: "PATCH", slab },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
