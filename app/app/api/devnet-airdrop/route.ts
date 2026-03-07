/**
 * PERC-475: Devnet Airdrop API
 *
 * POST /api/devnet-airdrop
 * Body: { mintAddress: string, walletAddress: string }
 *
 * Airdrops $500 USD worth of a devnet mirror token to a wallet.
 * The mintAddress must exist in the devnet_mints table (a mirror market mint).
 *
 * Flow:
 * 1. Validate mintAddress is in devnet_mints table → get mainnet_ca, symbol, decimals
 * 2. Fetch current mainnet price from DexScreener for mainnet_ca
 * 3. Calculate amount = $500 USD at current price
 *    (min: 1_000 raw, max: 3_200_000_000 raw at 6 decimals = 3,200 tokens)
 * 4. Mint to walletAddress using DEVNET_MINT_AUTHORITY_KEYPAIR
 * 5. Return { signature, amount, symbol }
 *
 * Rate limit: 1 request per wallet per mint per 24h (in-memory).
 * Only callable on devnet.
 *
 * Requires: DEVNET_MINT_AUTHORITY_KEYPAIR env var (JSON secret key bytes)
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
  getAccount,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() ?? "mainnet";

/** Target USD value to airdrop per claim */
const AIRDROP_USD_VALUE = 500;

/** Min/max raw token amounts at 6 decimals */
const MIN_RAW = 1_000n;        // 0.001 tokens — floor for high-priced assets
const MAX_RAW = 3_200_000_000n; // 3,200 tokens — cap prevents draining low-price mints

/** Rate limit: 1 claim per wallet per mint per 24h */
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
interface ClaimEntry { claimedAt: number }
const claimMap = new Map<string, ClaimEntry>();

function checkRateLimit(walletAddress: string, mintAddress: string): { allowed: boolean; retryAfterSecs: number } {
  const key = `${walletAddress}:${mintAddress}`;
  const now = Date.now();

  // GC stale entries occasionally
  if (Math.random() < 0.02) {
    for (const [k, v] of claimMap) {
      if (now - v.claimedAt > RATE_LIMIT_WINDOW_MS) claimMap.delete(k);
    }
  }

  const entry = claimMap.get(key);
  if (entry) {
    const age = now - entry.claimedAt;
    if (age < RATE_LIMIT_WINDOW_MS) {
      return { allowed: false, retryAfterSecs: Math.ceil((RATE_LIMIT_WINDOW_MS - age) / 1000) };
    }
  }
  return { allowed: true, retryAfterSecs: 0 };
}

function recordClaim(walletAddress: string, mintAddress: string) {
  claimMap.set(`${walletAddress}:${mintAddress}`, { claimedAt: Date.now() });
}

/** Fetch token price from DexScreener for the mainnet CA */
async function fetchTokenPriceUsd(mainnetCa: string): Promise<{ priceUsd: number } | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mainnetCa}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = Array.isArray(json.pairs) ? json.pairs : [];
    if (pairs.length === 0) return null;

    // Pick the pair with the most liquidity
    const sorted = [...pairs].sort(
      (a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const price = parseFloat((sorted[0] as any).priceUsd ?? "0");
    if (price <= 0) return null;
    return { priceUsd: price };
  } catch {
    return null;
  }
}

/** Wrap a promise with a timeout (ms). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export async function POST(req: NextRequest) {
  try {
    if (NETWORK !== "devnet") {
      return NextResponse.json({ error: "Only available on devnet" }, { status: 403 });
    }

    const body = await req.json();
    const { mintAddress, walletAddress } = body as {
      mintAddress?: string;
      walletAddress?: string;
    };

    if (!mintAddress || !walletAddress) {
      return NextResponse.json(
        { error: "Missing mintAddress or walletAddress" },
        { status: 400 },
      );
    }

    // Validate public keys
    let mintPk: PublicKey;
    let walletPk: PublicKey;
    try {
      mintPk = new PublicKey(mintAddress);
    } catch {
      return NextResponse.json({ error: "Invalid mintAddress" }, { status: 400 });
    }
    try {
      walletPk = new PublicKey(walletAddress);
    } catch {
      return NextResponse.json({ error: "Invalid walletAddress" }, { status: 400 });
    }

    // 1. Validate mintAddress exists in devnet_mints table → get mainnet_ca + metadata
    const supabase = getServiceClient();
    const { data: mintRow, error: dbErr } = await (supabase as any)
      .from("devnet_mints")
      .select("mainnet_ca, symbol, decimals")
      .eq("devnet_mint", mintAddress)
      .maybeSingle();

    if (dbErr || !mintRow) {
      return NextResponse.json(
        { error: "mintAddress is not a known devnet mirror mint" },
        { status: 400 },
      );
    }

    const { mainnet_ca: mainnetCa, symbol, decimals: rawDecimals } = mintRow;
    const decimals: number = rawDecimals ?? 6;

    // 2. Rate limit: 1 per wallet per mint per 24h
    const { allowed, retryAfterSecs } = checkRateLimit(walletAddress, mintAddress);
    if (!allowed) {
      const h = Math.floor(retryAfterSecs / 3600);
      const m = Math.floor((retryAfterSecs % 3600) / 60);
      return NextResponse.json(
        {
          error: `Already claimed — try again in ${h}h ${m}m`,
          retryAfterSecs,
          nextClaimAt: new Date(Date.now() + retryAfterSecs * 1000).toISOString(),
        },
        {
          status: 429,
          headers: { "Retry-After": String(retryAfterSecs) },
        },
      );
    }

    // 3. Fetch mainnet price from DexScreener
    const priceResult = await fetchTokenPriceUsd(mainnetCa);
    let rawAmount: bigint;

    if (priceResult && priceResult.priceUsd > 0) {
      // $500 / price = tokens; scale by decimals
      const tokensFloat = AIRDROP_USD_VALUE / priceResult.priceUsd;
      rawAmount = BigInt(Math.floor(tokensFloat * 10 ** decimals));
    } else {
      // Price unavailable — fall back to a fixed generous amount (1000 tokens)
      rawAmount = BigInt(1000 * 10 ** decimals);
    }

    // Clamp to [MIN_RAW, MAX_RAW]
    if (rawAmount < MIN_RAW) rawAmount = MIN_RAW;
    if (rawAmount > MAX_RAW) rawAmount = MAX_RAW;

    // 4. Load mint authority
    const mintAuthKeyJson = process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    if (!mintAuthKeyJson) {
      return NextResponse.json(
        { error: "Server not configured for devnet minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
        { status: 500 },
      );
    }
    let mintAuthority: Keypair;
    try {
      mintAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(mintAuthKeyJson)));
    } catch {
      return NextResponse.json({ error: "Server keypair configuration is invalid" }, { status: 500 });
    }

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Derive user's ATA
    const ata = await getAssociatedTokenAddress(mintPk, walletPk);
    let ataExists = false;
    try {
      await getAccount(connection, ata);
      ataExists = true;
    } catch {
      // ATA doesn't exist yet — will be created in tx
    }

    // 5. Build and send mint transaction
    const tx = new Transaction();
    if (!ataExists) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          mintAuthority.publicKey, // payer
          ata,
          walletPk,
          mintPk,
        ),
      );
    }
    tx.add(createMintToInstruction(mintPk, ata, mintAuthority.publicKey, rawAmount));

    const sig = await withTimeout(
      sendAndConfirmTransaction(connection, tx, [mintAuthority], { commitment: "confirmed" }),
      30_000,
    );

    // Record claim only after successful mint
    recordClaim(walletAddress, mintAddress);

    const humanAmount = Number(rawAmount) / 10 ** decimals;

    return NextResponse.json({
      signature: sig,
      amount: humanAmount,
      rawAmount: rawAmount.toString(),
      symbol: symbol ?? "TOKEN",
      decimals,
      nextClaimAt: new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toISOString(),
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-airdrop", method: "POST" },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
