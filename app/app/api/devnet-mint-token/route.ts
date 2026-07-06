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
  VersionedTransaction,
  SystemProgram,
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
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import { validateTokenMetadata, validateDexScreenerResponse } from "@/lib/token-metadata-validators";
import * as Sentry from "@sentry/nextjs";
import { getClientIp } from "@/lib/get-client-ip";
import { checkMintRateLimit } from "@/lib/devnet-mirror-mint-rate-limit";
import { tryFaucetGate, releaseFaucetClaim } from "@/lib/faucet-rate-gate";

export const dynamic = "force-dynamic";

// Canonical env var first, legacy fallback; undefined = non-devnet (fail-closed)
const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
const AIRDROP_USD_VALUE = 500; // $500 worth of tokens
// ORACLE_BRIDGE_URL removed — unreachable from Vercel serverless.
// Price fetching uses DexScreener API directly via fetchTokenInfo().

interface DexScreenerToken {
  name: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  logoUrl?: string;
}

/** NAME-VALIDATION-001: Maximum length constraints for token metadata fields */
const MAX_TOKEN_NAME_LEN = 255;
const MAX_TOKEN_SYMBOL_LEN = 20;

/**
 * Sanitizes token name to ensure it doesn't exceed max length.
 * NAME-VALIDATION-001: Prevents buffer overflow or database constraint violations.
 */
function sanitizeTokenName(name: string): string {
  if (!name || typeof name !== 'string') return 'Unknown';
  return name.slice(0, MAX_TOKEN_NAME_LEN).trim() || 'Unknown';
}

/**
 * Sanitizes token symbol to ensure it doesn't exceed max length.
 * Keeps consistency with name validation.
 */
function sanitizeTokenSymbol(symbol: string): string {
  if (!symbol || typeof symbol !== 'string') return '???';
  return symbol.slice(0, MAX_TOKEN_SYMBOL_LEN).trim() || '???';
}

/** Fetch token metadata and price from DexScreener, with DEXSCREENER-001 validation */
async function fetchTokenInfo(ca: string): Promise<DexScreenerToken | null> {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    const pairs = json.pairs as unknown;

    // DEXSCREENER-001: Validate external API response
    const validated = validateDexScreenerResponse(pairs);
    if (!validated) return null;

    // Extract price from best pair (validate separately)
    if (!Array.isArray(json.pairs) || json.pairs.length === 0) {
      return null;
    }
    const rawPrice = parseFloat(json.pairs[0]?.priceUsd ?? "0");
    if (rawPrice <= 0) return null;

    return {
      ...validated,
      priceUsd: rawPrice,
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

    // Reject URLs and non-base58 inputs — prevents DexScreener being called with a URL
    const isUrl = typeof mainnetCA === "string" &&
      (mainnetCA.startsWith("http://") || mainnetCA.startsWith("https://") || mainnetCA.includes("://"));
    if (isUrl) {
      return NextResponse.json(
        { error: "Paste a valid Solana token address, not a URL" },
        { status: 400 },
      );
    }
    try {
      new PublicKey(mainnetCA);
    } catch {
      return NextResponse.json(
        { error: "Invalid token address: must be a valid Solana base58 public key" },
        { status: 400 },
      );
    }

    let creatorPk: PublicKey;
    try {
      creatorPk = new PublicKey(creatorWallet);
    } catch {
      return NextResponse.json({ error: "Invalid creatorWallet" }, { status: 400 });
    }

    // Guard: SPL token accounts require an on-curve (Ed25519) owner.
    // Passing a PDA (off-curve) as the creator wallet causes
    // TokenOwnerOffCurveError during getAssociatedTokenAddress.
    // Reject early with a clear 400 before touching the DB or chain.
    if (!PublicKey.isOnCurve(creatorPk.toBytes())) {
      return NextResponse.json(
        { error: "creatorWallet must be a regular wallet, not a program-derived address (PDA)" },
        { status: 400 },
      );
    }

    // 1. Per-IP rate limit (same guard devnet-mirror-mint uses).
    const clientIp = getClientIp(req);
    const { allowed: ipAllowed, retryAfter } = await checkMintRateLimit(clientIp);
    if (!ipAllowed) {
      return NextResponse.json(
        { error: "Too many mint requests. Please wait before retrying." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    // 2. Per-wallet durable claim gate: one $500 grant per wallet per token per 24 hours.
    const supabase = getServiceClient();
    const gate = await tryFaucetGate(supabase, creatorWallet, `devnet-mint:${mainnetCA}`);
    if (!gate.allowed) {
      return NextResponse.json(
        {
          error: gate.nextClaimAt
            ? "Already minted for this wallet/token in the last 24 hours"
            : "Service temporarily unavailable",
          nextClaimAt: gate.nextClaimAt,
        },
        { status: gate.nextClaimAt ? 429 : 503 },
      );
    }

    let mintSucceeded = false;
    try {
      // Check if we already have a devnet mint for this CA
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await supabase
        .from("devnet_mints")
        .select("devnet_mint")
        .eq("mainnet_ca", mainnetCA)
        .maybeSingle();

    // Load mint authority (needed for both already_exists airdrop and new mint creation)
    const mintSigner = getDevnetMintSigner();
    if (!mintSigner) {
      // If mint authority not configured and an existing mint is found, return it without airdrop
      if (existing?.devnet_mint) {
        return NextResponse.json({
          status: "already_exists",
          devnetMint: existing.devnet_mint,
        });
      }
      return NextResponse.json(
        { error: "Server not configured for minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
        { status: 500 },
      );
    }
    const mintAuthPk = new PublicKey(mintSigner.publicKey());

    // Fetch token info from DexScreener
    const tokenInfo = await fetchTokenInfo(mainnetCA);
    if (!tokenInfo) {
      // If we have an existing devnet mint, return it even if token info fetch fails
      if (existing?.devnet_mint) {
        return NextResponse.json({
          status: "already_exists",
          devnetMint: existing.devnet_mint,
        });
      }
      return NextResponse.json(
        { error: "Cannot fetch token info. Token may not have liquidity on any DEX." },
        { status: 400 },
      );
    }

    // NAME-VALIDATION-001: Sanitize token name and symbol before any usage.
    // This prevents buffer overflow, database constraint violations, and XSS-like issues.
    tokenInfo.name = sanitizeTokenName(tokenInfo.name);
    tokenInfo.symbol = sanitizeTokenSymbol(tokenInfo.symbol);

    const cfg = getConfig();
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // BUG-1 FIX: If devnet mint already exists, airdrop tokens to creator instead of
    // creating a new mint. devnet-mirror-mint creates the mint during wizard Step 1, so
    // by the time this endpoint is called (post-market-creation), the mint already exists.
    if (existing?.devnet_mint) {
      try {
        const existingMintPk = new PublicKey(existing.devnet_mint);
        const decimals = tokenInfo.decimals;
        const tokensFloat = AIRDROP_USD_VALUE / tokenInfo.priceUsd;
        const airdropAmount = BigInt(Math.floor(tokensFloat * 10 ** decimals));

        const creatorAta = await getAssociatedTokenAddress(existingMintPk, creatorPk);
        const airdropTx = new Transaction();

        // Create creator ATA if it doesn't exist
        const ataInfo = await connection.getAccountInfo(creatorAta);
        if (!ataInfo) {
          airdropTx.add(
            createAssociatedTokenAccountInstruction(
              mintAuthPk,
              creatorAta,
              creatorPk,
              existingMintPk,
            ),
          );
        }

        airdropTx.add(
          createMintToInstruction(
            existingMintPk,
            creatorAta,
            mintAuthPk,
            airdropAmount,
          ),
        );

        // Set recentBlockhash and feePayer before signing (required for sendRawTransaction).
        const { blockhash: airdropBlockhash } = await connection.getLatestBlockhash();
        airdropTx.recentBlockhash = airdropBlockhash;
        airdropTx.feePayer = mintAuthPk;

        // Sign and send raw — sendAndConfirmTransaction wipes the sealed signer's signature
        // by calling tx.sign(signers) internally. Use sendRawTransaction instead.
        const signedAirdropTx = mintSigner.signTransaction(airdropTx);
        const airdropTxSig = await connection.sendRawTransaction(
          (signedAirdropTx as Transaction).serialize(),
        );
        await connection.confirmTransaction(airdropTxSig, "confirmed");

        mintSucceeded = true;
        return NextResponse.json({
          status: "already_exists",
          devnetMint: existing.devnet_mint,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          decimals,
          priceUsd: tokenInfo.priceUsd,
          airdropTokens: tokensFloat,
          airdropUsd: AIRDROP_USD_VALUE,
        });
      } catch (airdropErr) {
        // Non-fatal — return existing mint even if airdrop fails
        console.warn("devnet-mint-token: airdrop to existing mint failed:", airdropErr);
        mintSucceeded = true;
        return NextResponse.json({
          status: "already_exists",
          devnetMint: existing.devnet_mint,
        });
      }
    }

    // Create new devnet mint
    const mintKeypair = Keypair.generate();
    const decimals = tokenInfo.decimals;
    const lamports = await getMinimumBalanceForRentExemptMint(connection);

    let tx: Transaction | VersionedTransaction = new Transaction();

    // Set recentBlockhash and feePayer before partial signing
    const { blockhash } = await connection.getLatestBlockhash();
    (tx as Transaction).recentBlockhash = blockhash;
    (tx as Transaction).feePayer = new PublicKey(mintSigner.publicKey());

    // Create mint account
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: mintAuthPk,
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
        mintAuthPk, // mint authority
        mintAuthPk, // freeze authority
      ),
    );

    // Create ATA for creator
    const creatorAta = await getAssociatedTokenAddress(mintKeypair.publicKey, creatorPk);
    tx.add(
      createAssociatedTokenAccountInstruction(
        mintAuthPk,
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
        mintAuthPk,
        airdropAmount,
      ),
    );

    // Multi-signer: partialSign mintKeypair FIRST so its signature is in the array,
    // then let the sealed signer add mintAuthority's sig via partialSign.
    // sendAndConfirmTransaction wipes all existing sigs (calls tx.sign(signers) internally)
    // so we use sendRawTransaction + confirmTransaction instead.
    (tx as Transaction).partialSign(mintKeypair);
    tx = mintSigner.signTransaction(tx);
    const sig = await connection.sendRawTransaction((tx as Transaction).serialize());
    await connection.confirmTransaction(sig, "confirmed");

    const devnetMint = mintKeypair.publicKey.toBase58();

    // Store in DB — INSERT-as-gate: devnet_mints has UNIQUE(mainnet_ca).
    // Under concurrent requests, the race loser gets Postgres 23505.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insertErr } = await supabase.from("devnet_mints").insert({
      mainnet_ca: mainnetCA,
      devnet_mint: devnetMint,
      market_address: marketAddress ?? null,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      decimals,
      logo_url: tokenInfo.logoUrl ?? null,
      creator_wallet: creatorWallet,
    });

      if (insertErr?.code === "23505") {
        // Race lost — a concurrent request already created and inserted this CA's mint.
        // The on-chain mint we just created is orphaned (devnet-only, ~0.002 SOL wasted).
        // Return the winner's mint address so the caller still gets a valid devnetMint.
        console.warn(
          `devnet-mint-token: TOCTOU race for ${mainnetCA} — orphaned mint ${devnetMint}, fetching winner`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: winner } = await supabase
          .from("devnet_mints")
          .select("devnet_mint")
          .eq("mainnet_ca", mainnetCA)
          .maybeSingle();
        mintSucceeded = true;
        return NextResponse.json({
          status: "already_exists",
          devnetMint: winner?.devnet_mint ?? devnetMint,
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          decimals,
          priceUsd: tokenInfo.priceUsd,
        });
      }

      if (insertErr) {
        // Unexpected DB error — log and surface (mint exists on-chain but not in DB)
        console.error("devnet-mint-token: DB insert failed:", insertErr.message);
        Sentry.captureException(insertErr, {
          tags: { endpoint: "/api/devnet-mint-token", phase: "db-insert" },
        });
      }

      // FIX: Also upsert markets table so /api/airdrop can find the mint.
      // The airdrop route looks up mint_address in the markets table, not devnet_mints.
      // Best-effort: if this fails, airdrop can still fall back to devnet_mints.
      if (marketAddress) {
        const { error: upsertErr } = await supabase.from("markets")
          .update({
            mint_address: devnetMint,
            symbol: tokenInfo.symbol,
          })
          .eq("slab_address", marketAddress);
        if (upsertErr) {
          console.warn("devnet-mint-token: markets upsert failed (non-fatal):", upsertErr.message);
        }
      }

      mintSucceeded = true;
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
    } finally {
      if (!mintSucceeded && gate.claimId !== undefined) {
        try {
          await releaseFaucetClaim(supabase, gate.claimId);
        } catch (releaseErr) {
          console.warn("devnet-mint-token: release claim failed:", releaseErr);
        }
      }
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { endpoint: "/api/devnet-mint-token", method: "POST" },
    });
    return NextResponse.json(
      { error: "Token minting failed. Please try again later." },
      { status: 500 },
    );
  }
}
