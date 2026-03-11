/**
 * PERC-363: Token airdrop endpoint
 *
 * POST /api/airdrop { marketAddress: string, walletAddress: string }
 *
 * Airdrops $500 USD worth of the market's devnet token to the wallet.
 * Rate limited: 1 claim per wallet per market per 24h.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK;
const AIRDROP_USD_VALUE = 500;
const RATE_LIMIT_HOURS = 24;

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
    }

    const body = await req.json();
    const { marketAddress, walletAddress } = body;

    if (!marketAddress || !walletAddress) {
      return NextResponse.json({ error: "Missing marketAddress or walletAddress" }, { status: 400 });
    }

    let walletPk: PublicKey;
    try { walletPk = new PublicKey(walletAddress); } catch {
      return NextResponse.json({ error: "Invalid walletAddress" }, { status: 400 });
    }

    const supabase = getServiceClient();

    // Rate limit check
    const cutoff = new Date(Date.now() - RATE_LIMIT_HOURS * 60 * 60 * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: recent } = await (supabase as any)
      .from("airdrop_claims")
      .select("id")
      .eq("wallet", walletAddress)
      .eq("market_address", marketAddress)
      .gte("claimed_at", cutoff)
      .limit(1);

    if (recent && recent.length > 0) {
      // Calculate time remaining
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: lastClaim } = await (supabase as any)
        .from("airdrop_claims")
        .select("claimed_at")
        .eq("wallet", walletAddress)
        .eq("market_address", marketAddress)
        .order("claimed_at", { ascending: false })
        .limit(1)
        .single();

      const nextClaimAt = lastClaim
        ? new Date(new Date(lastClaim.claimed_at).getTime() + RATE_LIMIT_HOURS * 60 * 60 * 1000).toISOString()
        : null;

      return NextResponse.json(
        { error: "Already claimed in the last 24 hours", nextClaimAt },
        { status: 429 },
      );
    }

    // Look up the devnet mint for this market (try markets table first, then devnet_mints)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: marketData } = await (supabase as any)
      .from("markets")
      .select("mint_address, symbol")
      .eq("slab_address", marketAddress)
      .maybeSingle();

    let mintAddress: string | null = marketData?.mint_address ?? null;
    let symbol: string = marketData?.symbol ?? "TOKEN";

    // FIX: Fallback to devnet_mints table if markets table doesn't have the mint.
    // devnet-mint-token stores the mint in devnet_mints; the markets table upsert
    // may have been missed (race condition or older markets created before the fix).
    if (!mintAddress) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: devnetMintData, error: fallbackErr } = await (supabase as any)
        .from("devnet_mints")
        .select("devnet_mint, symbol")
        .eq("market_address", marketAddress)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fallbackErr) {
        console.warn("airdrop: devnet_mints fallback query failed:", fallbackErr.message);
      }

      if (devnetMintData?.devnet_mint) {
        mintAddress = devnetMintData.devnet_mint;
        symbol = devnetMintData.symbol ?? symbol;
      }
    }

    if (!mintAddress) {
      return NextResponse.json({ error: "Market not found — no devnet mint exists for this market" }, { status: 404 });
    }

    const mintPk = new PublicKey(mintAddress);

    // Get current price from oracle bridge
    let priceUsd = 1.0; // fallback
    try {
      // Try to get price from the market's oracle or bridge
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: stats } = await (supabase as any)
        .from("markets_with_stats")
        .select("last_price")
        .eq("slab_address", marketAddress)
        .maybeSingle();

      if (stats?.last_price && stats.last_price > 0) {
        priceUsd = stats.last_price;
      }
    } catch {}

    // Load mint authority
    const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    if (!mintAuthKeyJson) {
      return NextResponse.json(
        { error: "Server not configured for minting" },
        { status: 500 },
      );
    }
    const mintAuthority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(mintAuthKeyJson)),
    );

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Calculate airdrop amount
    const decimals = 6; // Standard for devnet mirrors
    const tokensFloat = AIRDROP_USD_VALUE / priceUsd;
    const airdropAmount = BigInt(Math.floor(tokensFloat * 10 ** decimals));

    const tx = new Transaction();

    // Create ATA if needed
    const ata = await getAssociatedTokenAddress(mintPk, walletPk);
    try {
      await connection.getTokenAccountBalance(ata);
    } catch {
      tx.add(
        createAssociatedTokenAccountInstruction(
          mintAuthority.publicKey,
          ata,
          walletPk,
          mintPk,
        ),
      );
    }

    // Mint tokens
    tx.add(
      createMintToInstruction(
        mintPk,
        ata,
        mintAuthority.publicKey,
        airdropAmount,
      ),
    );

    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [mintAuthority],
      { commitment: "confirmed" },
    );

    // Record claim
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("airdrop_claims").insert({
      wallet: walletAddress,
      market_address: marketAddress,
      amount_tokens: tokensFloat,
      amount_usd: AIRDROP_USD_VALUE,
      signature: sig,
    });

    return NextResponse.json({
      status: "airdropped",
      symbol,
      tokens: tokensFloat,
      usdValue: AIRDROP_USD_VALUE,
      signature: sig,
      nextClaimAt: new Date(Date.now() + RATE_LIMIT_HOURS * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/airdrop", method: "POST" },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
