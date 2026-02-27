import { NextRequest, NextResponse } from "next/server";
// requireAuth removed from POST — on-chain admin verification is sufficient
import { Connection, PublicKey } from "@solana/web3.js";
import { parseHeader } from "@percolator/sdk";
import { getServiceClient } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

// GET /api/markets — list all active markets with stats
export async function GET() {
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from("markets_with_stats")
      .select(
        "slab_address,mint_address,symbol,name,decimals,deployer,logo_url,max_leverage,trading_fee_bps," +
        "last_price,mark_price,volume_24h,open_interest_long,open_interest_short,total_open_interest," +
        "insurance_fund,insurance_balance,total_accounts,funding_rate,net_lp_pos,lp_sum_abs,c_tot," +
        "vault_balance,created_at,stats_updated_at"
      );

    if (error) {
      Sentry.captureException(error, {
        tags: { endpoint: "/api/markets", method: "GET" },
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ markets: data }, {
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
  } = body;

  if (!slab_address || !mint_address || !deployer) {
    return NextResponse.json(
      { error: "Missing required fields: slab_address, mint_address, deployer" },
      { status: 400 }
    );
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
