import { NextRequest, NextResponse } from "next/server";
import { requireAuth, UNAUTHORIZED } from "@/lib/api-auth";
import { Connection, PublicKey } from "@solana/web3.js";
import { getServiceClient } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
export const dynamic = "force-dynamic";

// GET /api/markets — list all active markets with stats
export async function GET() {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("markets_with_stats")
    .select("*");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ markets: data });
}

// POST /api/markets — register a new market after deployment
export async function POST(req: NextRequest) {
  if (!requireAuth(req)) return UNAUTHORIZED;
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
}
