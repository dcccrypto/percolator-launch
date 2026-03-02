/**
 * PERC-362: Devnet Token Mint API
 *
 * POST /api/devnet-mint-token
 * Body: { mainnetCA: string, marketAddress: string, creatorWallet: string }
 *
 * Creates a devnet SPL mint mirroring a mainnet token, then airdrops
 * $500 USD worth of tokens to the creator's wallet at current price.
 *
 * Requires: DEVNET_MINT_AUTHORITY_KEYPAIR env var (JSON secret key bytes)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  getMinimumBalanceForRentExemptMint,
  createInitializeMintInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
const AIRDROP_USD_VALUE = 500; // $500 worth of tokens
const ORACLE_BRIDGE_URL = process.env.ORACLE_BRIDGE_URL ?? "http://127.0.0.1:18802";

interface DexScreenerToken {
  name: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  logoUrl?: string;
}

/** Fetch token metadata and price from DexScreener */
async function fetchTokenInfo(ca: string): Promise<DexScreenerToken | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = json.pairs as Array<{
      baseToken?: { name?: string; symbol?: string };
      priceUsd?: string;
      liquidity?: { usd?: number };
      info?: { imageUrl?: string };
    }>[] | undefined;

    if (!pairs || pairs.length === 0) return null;

    // Sort by liquidity, pick best
    const sorted = [...pairs].sort(
      (a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const best = sorted[0] as any;
    const price = parseFloat(best.priceUsd ?? "0");
    if (price <= 0) return null;

    return {
      name: best.baseToken?.name ?? `Token ${ca.slice(0, 6)}`,
      symbol: best.baseToken?.symbol ?? ca.slice(0, 4).toUpperCase(),
      decimals: 6, // Default to 6 for devnet mirror (simplifies math)
      priceUsd: price,
      logoUrl: best.info?.imageUrl,
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
    }

    const body = await req.json();
    const { mainnetCA, marketAddress, creatorWallet } = body;

    if (!mainnetCA || !creatorWallet) {
      return NextResponse.json(
        { error: "Missing mainnetCA or creatorWallet" },
        { status: 400 },
      );
    }

    let creatorPk: PublicKey;
    try {
      creatorPk = new PublicKey(creatorWallet);
    } catch {
      return NextResponse.json({ error: "Invalid creatorWallet" }, { status: 400 });
    }

    // Check if we already have a devnet mint for this CA
    const supabase = getServiceClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabase as any)
      .from("devnet_mints")
      .select("devnet_mint")
      .eq("mainnet_ca", mainnetCA)
      .maybeSingle();

    if (existing?.devnet_mint) {
      return NextResponse.json({
        status: "already_exists",
        devnetMint: existing.devnet_mint,
      });
    }

    // Load mint authority
    const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    if (!mintAuthKeyJson) {
      return NextResponse.json(
        { error: "Server not configured for minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
        { status: 500 },
      );
    }
    const mintAuthority = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(mintAuthKeyJson)),
    );

    // Fetch token info from DexScreener
    const tokenInfo = await fetchTokenInfo(mainnetCA);
    if (!tokenInfo) {
      return NextResponse.json(
        { error: "Cannot fetch token info. Token may not have liquidity on any DEX." },
        { status: 400 },
      );
    }

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Create new devnet mint
    const mintKeypair = Keypair.generate();
    const decimals = tokenInfo.decimals;
    const lamports = await getMinimumBalanceForRentExemptMint(connection);

    const tx = new Transaction();

    // Create mint account
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: mintAuthority.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
    );

    // Initialize mint
    tx.add(
      createInitializeMintInstruction(
        mintKeypair.publicKey,
        decimals,
        mintAuthority.publicKey, // mint authority
        mintAuthority.publicKey, // freeze authority
      ),
    );

    // Create ATA for creator
    const creatorAta = await getAssociatedTokenAddress(mintKeypair.publicKey, creatorPk);
    tx.add(
      createAssociatedTokenAccountInstruction(
        mintAuthority.publicKey,
        creatorAta,
        creatorPk,
        mintKeypair.publicKey,
      ),
    );

    // Calculate airdrop amount: $500 / price = tokens, then scale by decimals
    const tokensFloat = AIRDROP_USD_VALUE / tokenInfo.priceUsd;
    const airdropAmount = BigInt(Math.floor(tokensFloat * 10 ** decimals));

    // Mint to creator
    tx.add(
      createMintToInstruction(
        mintKeypair.publicKey,
        creatorAta,
        mintAuthority.publicKey,
        airdropAmount,
      ),
    );

    const sig = await sendAndConfirmTransaction(
      connection,
      tx,
      [mintAuthority, mintKeypair],
      { commitment: "confirmed" },
    );

    const devnetMint = mintKeypair.publicKey.toBase58();

    // Store in DB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("devnet_mints").insert({
      mainnet_ca: mainnetCA,
      devnet_mint: devnetMint,
      market_address: marketAddress ?? null,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      decimals,
      logo_url: tokenInfo.logoUrl ?? null,
      creator_wallet: creatorWallet,
    });

    return NextResponse.json({
      status: "created",
      devnetMint,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      decimals,
      priceUsd: tokenInfo.priceUsd,
      airdropTokens: tokensFloat,
      airdropUsd: AIRDROP_USD_VALUE,
      signature: sig,
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-mint-token", method: "POST" },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
