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
 * 2. INSERT-as-gate: atomically reserve the claim slot (eliminates TOCTOU race)
 * 3. Fetch current mainnet price from DexScreener for mainnet_ca
 * 4. Calculate amount = $500 USD at current price
 *    (min: 1_000 raw, max: 3_200_000_000 raw at 6 decimals = 3,200 tokens)
 * 5. Mint to walletAddress using DEVNET_MINT_AUTHORITY_KEYPAIR
 *    On mint failure: release the reserved slot so user can retry.
 * 6. Return { signature, amount, symbol }
 *
 * Rate limit: 1 request per wallet per mint per 24h (Supabase-backed, TOCTOU-safe).
 * Only callable on devnet.
 *
 * Requires: DEVNET_MINT_AUTHORITY_KEYPAIR env var (JSON secret key bytes)
 *
 * GH#1769: When the stored mint address is not owned by the server keypair
 * (user-created devnet-native token or token-factory mint), auto-resolve to a
 * server-owned Percolator mirror mint for the same mainnet CA. This ensures the
 * "Get Test Tokens" flow works immediately after market creation without requiring
 * the user to navigate to the devnet faucet page.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createInitializeMintInstruction,
  getAccount,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { getConfig } from "@/lib/config";
import { getServiceClient } from "@/lib/supabase";
import { getDevnetMintSigner } from "@/lib/devnet-signer";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

const NETWORK =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();

/** Target USD value to airdrop per claim */
const AIRDROP_USD_VALUE = 500;

/** Min/max raw token amounts at 6 decimals */
const MIN_RAW = 1_000n;        // 0.001 tokens — floor for high-priced assets
const MAX_RAW = 3_200_000_000n; // 3,200 tokens — cap prevents draining low-price mints

/** Rate limit: 1 claim per wallet per mint per 24h (Supabase-backed) */
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Atomically try to reserve a claim slot for wallet+mint (INSERT-as-gate).
 *
 * This eliminates the SELECT→INSERT TOCTOU race present in the previous
 * checkRateLimit + recordClaim two-step approach. Because the
 * devnet_airdrop_claims table has a UNIQUE INDEX on (wallet, mint), the DB
 * serialises concurrent INSERTs — exactly one will succeed; the rest get a
 * unique-violation and are denied without any window for a double-spend.
 *
 * Re-claim after 24h: before the gate INSERT we delete any expired row for
 * this wallet+mint so the unique slot is free for a new window.
 *
 * Returns:
 *   { allowed: true,  claimId }  — slot reserved, proceed with mint
 *   { allowed: false, retryAfterSecs } — already claimed within 24h
 */
async function tryClaimGate(
  supabase: ReturnType<typeof getServiceClient>,
  walletAddress: string,
  mintAddress: string,
): Promise<{ allowed: boolean; retryAfterSecs: number; claimId?: number }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  try {
    // Pre-check (GH#1803-style): active claim in window → deny before INSERT so a
    // transient INSERT error cannot fail-open into the mint path for rate-limited wallets.
    const { data: activeClaim } = await supabase
      .from("devnet_airdrop_claims")
      .select("claimed_at")
      .eq("wallet", walletAddress)
      .eq("mint", mintAddress)
      .gte("claimed_at", windowStart)
      .maybeSingle();

    if (activeClaim) {
      const age = Date.now() - new Date(activeClaim.claimed_at as string).getTime();
      const retryAfterSecs = Math.ceil((RATE_LIMIT_WINDOW_MS - age) / 1000);
      return { allowed: false, retryAfterSecs: Math.max(0, retryAfterSecs) };
    }

    // Step 1: Clear any expired claim so the unique slot is free for re-claiming.
    // This is safe even under concurrency: two concurrent DELETEs on the same
    // expired row are idempotent; the second finds nothing and succeeds silently.
    await supabase
      .from("devnet_airdrop_claims")
      .delete()
      .eq("wallet", walletAddress)
      .eq("mint", mintAddress)
      .lt("claimed_at", windowStart);

    // Step 2: INSERT-as-gate.
    // Only one concurrent request can win the unique constraint; all others get
    // a postgres error code 23505 and are denied — atomically, with no gap.
    const { data, error } = await supabase
      .from("devnet_airdrop_claims")
      .insert({ wallet: walletAddress, mint: mintAddress, claimed_at: new Date().toISOString() })
      .select("id, claimed_at")
      .maybeSingle();

    if (error) {
      if (error.code === "23505") {
        // Unique violation = active claim within 24h. Fetch it to compute retry time.
        const { data: existing } = await supabase
          .from("devnet_airdrop_claims")
          .select("claimed_at")
          .eq("wallet", walletAddress)
          .eq("mint", mintAddress)
          .maybeSingle();

        if (existing) {
          const age = Date.now() - new Date(existing.claimed_at as string).getTime();
          const retryAfterSecs = Math.ceil((RATE_LIMIT_WINDOW_MS - age) / 1000);
          return { allowed: false, retryAfterSecs: Math.max(0, retryAfterSecs) };
        }
        // Row vanished between the conflict and the read (highly unlikely) — deny conservatively.
        return { allowed: false, retryAfterSecs: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
      }

      // Unexpected DB error — fail open to avoid blocking users; capture for alerting.
      const dbErr = new Error(`[devnet-airdrop] gate INSERT failed: ${error.message}`);
      console.warn(dbErr.message);
      Sentry.captureException(dbErr, {
        tags: { endpoint: "/api/devnet-airdrop", step: "try_claim_gate" },
        extra: { supabase_code: error.code, walletAddress, mintAddress },
      });
      return { allowed: true, retryAfterSecs: 0 };
    }

    return { allowed: true, retryAfterSecs: 0, claimId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[devnet-airdrop] tryClaimGate threw:", msg);
    Sentry.captureException(err, {
      tags: { endpoint: "/api/devnet-airdrop", step: "try_claim_gate" },
      extra: { walletAddress, mintAddress },
    });
    return { allowed: true, retryAfterSecs: 0 };
  }
}

/**
 * Release a reserved claim slot identified by its row id.
 *
 * Called only when the on-chain mint fails AFTER tryClaimGate succeeded,
 * so the user isn't locked out for 24h due to a transient network/RPC error.
 */
async function releaseClaim(
  supabase: ReturnType<typeof getServiceClient>,
  claimId: number,
): Promise<void> {
  const { error } = await supabase
    .from("devnet_airdrop_claims")
    .delete()
    .eq("id", claimId);

  if (error) {
    console.warn("[devnet-airdrop] failed to release claim slot:", error.message);
  }
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
      (a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
        (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const price = parseFloat(sorted[0].priceUsd ?? "0");
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

/**
 * GH#1769: Resolve a server-owned devnet mint for a given mainnet CA.
 *
 * When the incoming mintAddress was NOT created by the server keypair (e.g.
 * a user-created token-factory mint or devnet-native token), we cannot call
 * MintTo on it. Instead, look for an existing Percolator-owned mirror in
 * devnet_mints keyed by mainnet_ca. If none exists, create one on the fly so
 * Get Test Tokens works immediately without requiring page reload or manual steps.
 *
 * Returns the devnet mint address that the server keypair can MintTo, or null
 * if the server keypair is not configured.
 */
async function resolveServerOwnedDevnetMint(
  supabase: ReturnType<typeof getServiceClient>,
  connection: Connection,
  mainnetCa: string,
  mintSigner: ReturnType<typeof getDevnetMintSigner>,
  symbol: string | null,
  decimals: number,
): Promise<string | null> {
  if (!mintSigner) return null;

  // 1. Look for an existing server-owned mirror in devnet_mints for this mainnetCa.
  //    The mainnet-mirror flow stores: mainnet_ca = <REAL_MAINNET_CA>, devnet_mint = <server-created devnet SPL>
  // GH#1771: Use .limit(1) instead of .maybeSingle() — multiple mirrors may exist
  // for the same mainnet_ca (e.g. re-keyed mirrors), causing a PGRST116 multi-row error.
  const { data: mirrorRows } = await supabase
    .from("devnet_mints")
    .select("devnet_mint")
    .eq("mainnet_ca", mainnetCa)
    .neq("devnet_mint", mainnetCa) // exclude self-referencing native devnet entries
    .order("created_at", { ascending: false })
    .limit(1);
  const mirrorRow = mirrorRows?.[0] ?? null;

  if (mirrorRow?.devnet_mint) {
    // Sanity-check: verify the server keypair is still the authority on-chain
    try {
      const mintPk = new PublicKey(mirrorRow.devnet_mint as string);
      const mintInfo = await connection.getAccountInfo(mintPk);
      if (mintInfo && mintInfo.data.length >= 36) {
        const mintData = new Uint8Array(mintInfo.data);
        const hasAuthority = new DataView(mintData.buffer, mintData.byteOffset).getUint32(0, true) === 1;
        const mintAuthPk = new PublicKey(mintSigner.publicKey());
        if (hasAuthority) {
          const onChainAuthority = new PublicKey(mintData.slice(4, 36));
          if (onChainAuthority.equals(mintAuthPk)) {
            return mirrorRow.devnet_mint as string;
          }
          // Authority mismatch — this row is stale; fall through to create a new one
          console.warn(
            `[devnet-airdrop] resolveServerOwnedDevnetMint: stale mirror ${mirrorRow.devnet_mint} ` +
            `for ${mainnetCa} — authority is ${onChainAuthority.toBase58().slice(0, 8)}, not server. Creating new.`,
          );
        }
      }
    } catch (e) {
      // RPC error — proceed with creating a new mirror
      console.warn("[devnet-airdrop] resolveServerOwnedDevnetMint: on-chain check failed:", e instanceof Error ? e.message : e);
    }
  }

  // 2. No valid server-owned mirror found — create one now.
  //    This handles the "devnet-native token created by Token Factory" case where
  //    the user is the mint authority and the server cannot MintTo the original mint.
  console.info(`[devnet-airdrop] GH#1769: creating server-owned mirror for mainnetCa=${mainnetCa}`);

  const mintAuthPk = new PublicKey(mintSigner.publicKey());
  const mintKeypair = Keypair.generate();
  let lamports: number;
  try {
    lamports = await getMinimumBalanceForRentExemptMint(connection);
  } catch (e) {
    Sentry.captureException(e, {
      tags: { endpoint: "/api/devnet-airdrop", step: "resolveServerOwnedDevnetMint.getMinimumBalance" },
    });
    return null;
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const createTx = new Transaction();
  createTx.recentBlockhash = blockhash;
  createTx.feePayer = mintAuthPk;

  createTx.add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthPk,
      newAccountPubkey: mintKeypair.publicKey,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  createTx.add(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthPk,
      mintAuthPk,
    ),
  );

  // Multi-signer: mintKeypair signs first, then server keypair signs
  createTx.partialSign(mintKeypair);
  const signedCreateTx = mintSigner.signTransaction(createTx) as Transaction;

  try {
    const createSig = await connection.sendRawTransaction(signedCreateTx.serialize());
    await connection.confirmTransaction(createSig, "confirmed");
  } catch (e) {
    Sentry.captureException(e, {
      tags: { endpoint: "/api/devnet-airdrop", step: "resolveServerOwnedDevnetMint.createMint" },
      extra: { mainnetCa },
    });
    console.error("[devnet-airdrop] resolveServerOwnedDevnetMint: mint creation failed:", e instanceof Error ? e.message : e);
    return null;
  }

  const newDevnetMint = mintKeypair.publicKey.toBase58();

  // 3. Store the new mirror in devnet_mints so future requests find it.
  //    Use upsert with ignoreDuplicates in case of concurrent creation race.
  //    Upsert failure is FATAL — without persistence, subsequent calls will
  //    create duplicate mints (CodeRabbit #2100 finding).
  const { error: upsertError } = await supabase.from("devnet_mints").upsert(
    {
      mainnet_ca: mainnetCa,
      devnet_mint: newDevnetMint,
      symbol: symbol ?? "TOKEN",
      name: symbol ?? "Token",
      decimals,
      creator_wallet: mintSigner.publicKey(),
    },
    { onConflict: "mainnet_ca", ignoreDuplicates: false },
  );
  if (upsertError) {
    Sentry.captureException(new Error(`[devnet-airdrop] mirror upsert failed: ${upsertError.message}`), {
      tags: { endpoint: "/api/devnet-airdrop", step: "resolveServerOwnedDevnetMint.upsert" },
      extra: { mainnetCa, newDevnetMint },
    });
    console.error("[devnet-airdrop] resolveServerOwnedDevnetMint: upsert failed (FATAL):", upsertError.message);
    return null;
  }

  console.info(`[devnet-airdrop] GH#1769: created server-owned mirror ${newDevnetMint} for ${mainnetCa}`);
  return newDevnetMint;
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

    // Guard: SPL token accounts require an on-curve (Ed25519) owner.
    // Passing a PDA (off-curve) as the destination wallet causes
    // TokenOwnerOffCurveError during createAssociatedTokenAccountInstruction.
    // Reject early with a clear 400 before touching the DB or chain.
    if (!PublicKey.isOnCurve(walletPk.toBytes())) {
      return NextResponse.json(
        { error: "walletAddress must be a regular wallet, not a program-derived address (PDA)" },
        { status: 400 },
      );
    }

    // 1. Validate mintAddress exists in devnet_mints table → get mainnet_ca + metadata
    //    GH#1703: Also fall back to markets table (mint_address) for market mints that
    //    were created directly (not via the mainnet mirror flow) so users can get test
    //    tokens for any active market without hitting the misleading "not a known devnet
    //    mirror mint" error. The server API (/api/faucet) already accepts these mints —
    //    the client-side gating was the only blocker.
    //    GH#1769: When devnet_mints has a self-referencing row (mainnet_ca = devnet_mint =
    //    mintAddress, registered via devnet-register-mint for native devnet tokens), look
    //    up the markets table to find the real mainnet_ca for DexScreener price lookup.
    const supabase = getServiceClient();
    // GH#1771: devnet_mints.devnet_mint should be unique, but add .limit(1) as a defensive
    // guard against any duplicate rows that could cause .maybeSingle() to throw.
    const { data: mintRow, error: dbErr } = await supabase
      .from("devnet_mints")
      .select("mainnet_ca, symbol, decimals")
      .eq("devnet_mint", mintAddress)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let mainnetCa: string | null;
    let symbol: string | null;
    let decimals: number;
    // GH#1769: Track whether this is a server-created mirror (can MintTo) or
    // a user-created native devnet token (needs resolveServerOwnedDevnetMint).
    let isSelfReferencingNativeMint = false;

    if (!dbErr && mintRow) {
      // Found in devnet_mints (mirror flow or native devnet registration)
      mainnetCa = mintRow.mainnet_ca;
      symbol = mintRow.symbol;
      decimals = mintRow.decimals ?? 6;

      // GH#1769: Self-referencing row = native devnet token registered by devnet-register-mint.
      // In this case mainnet_ca === devnet_mint === mintAddress — meaning the "mainnetCa"
      // we have is actually the devnet address, not a real mainnet CA. Try to find the
      // real mainnet_ca from the markets table for better price lookup and mirror resolution.
      if (mainnetCa === mintAddress) {
        isSelfReferencingNativeMint = true;
        // GH#1771: mint_address can appear in multiple markets rows (shared mints).
        // Use .limit(1) to avoid .maybeSingle() multi-row error; prefer rows with a non-null
        // mainnet_ca by ordering newest first so we get the most useful row.
        const { data: _nativeRows } = await supabase
          .from("markets")
          .select("mainnet_ca, symbol, decimals")
          .eq("mint_address", mintAddress)
          .order("created_at", { ascending: false })
          .limit(5);
        // Pick the first row that has a real mainnet_ca (not null, not self-referencing)
        const marketForNative =
          (_nativeRows as Array<{ mainnet_ca: string | null; symbol: string | null; decimals: number | null }> | null)
            ?.find((r) => r.mainnet_ca && r.mainnet_ca !== mintAddress) ??
          (_nativeRows?.[0] ?? null);
        if (marketForNative?.mainnet_ca && marketForNative.mainnet_ca !== mintAddress) {
          // Found a real mainnet CA — use it for DexScreener price lookup
          mainnetCa = marketForNative.mainnet_ca;
          if (!symbol && marketForNative.symbol) symbol = marketForNative.symbol;
          if (!decimals && marketForNative.decimals) decimals = marketForNative.decimals ?? 6;
        }
        // mainnetCa may still equal mintAddress if no real CA found; that's fine —
        // DexScreener will return no price and we'll use the 1000-token fallback.
      }
    } else {
      // Fallback: check markets table for mint_address match (direct-created market mints)
      // GH#1771: Use .limit(1) instead of .maybeSingle() — a mint can appear
      // in multiple markets rows (shared mints), causing a PGRST116 multi-row error.
      const { data: marketRows, error: marketErr } = await supabase
        .from("markets")
        .select("mainnet_ca, symbol, decimals")
        .eq("mint_address", mintAddress)
        .order("created_at", { ascending: false })
        .limit(1);
      const marketRow = marketRows?.[0] ?? null;

      if (marketErr || !marketRow) {
        return NextResponse.json(
          { error: "This address is not a Percolator devnet market mint. Paste the mint address of an active market from /markets." },
          { status: 400 },
        );
      }

      mainnetCa = marketRow.mainnet_ca;
      symbol = marketRow.symbol;
      decimals = marketRow.decimals ?? 6;
      // Markets table entry without a devnet_mints row = native devnet mint or unregistered mirror
      isSelfReferencingNativeMint = !mainnetCa || mainnetCa === mintAddress;
    }

    // 2. INSERT-as-gate: atomically reserve the claim slot BEFORE minting.
    //    This eliminates the TOCTOU race in the previous SELECT→UPSERT flow.
    const { allowed, retryAfterSecs, claimId } = await tryClaimGate(supabase, walletAddress, mintAddress);
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

    // Steps 3–5 are wrapped so that ANY failure after the gate INSERT
    // releases the claim slot. Previously, exceptions between the gate and
    // the mint try-catch (e.g. DexScreener fetch, ATA derivation) would
    // skip releaseClaim, locking the user out for 24h on a transient error.
    let mintSucceeded = false;
    let sig: string;
    let rawAmount: bigint;
    try {
      // 3. Fetch mainnet price from DexScreener
      const priceResult = mainnetCa ? await fetchTokenPriceUsd(mainnetCa) : null;

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

      // 4. Load mint authority using sealed signer factory
      const mintSigner = getDevnetMintSigner();
      if (!mintSigner) {
        return NextResponse.json(
          { error: "Server not configured for devnet minting (DEVNET_MINT_AUTHORITY_KEYPAIR missing)" },
          { status: 500 },
        );
      }
      const mintAuthPk = new PublicKey(mintSigner.publicKey());

      const cfg = getConfig();
      const connection = new Connection(cfg.rpcUrl, "confirmed");

      // Verify we are the mint authority — if not, we cannot mint tokens.
      // This happens for devnet-native tokens (e.g. user pasted a token address
      // that exists on devnet but was created by someone else, e.g. Token Factory).
      //
      // GH#1769: Instead of returning a 400, auto-resolve to a server-owned mirror mint
      // for the same mainnet CA. This ensures "Get Test Tokens" works immediately after
      // market creation even when the market uses a user-created devnet-native token.
      let effectiveMintPk = mintPk;
      let effectiveMintAddress = mintAddress;
      try {
        const mintInfo = await connection.getAccountInfo(mintPk);
        if (!mintInfo) {
          return NextResponse.json(
            { error: `Mint ${mintAddress} does not exist on devnet. The token may need to be mirrored first.` },
            { status: 400 },
          );
        }
        // SPL Token mint layout: bytes 0-3 = coption(u32), bytes 4-35 = mint_authority (32 bytes)
        // If coption == 0, no mint authority (fixed supply). If coption == 1, authority is at offset 4.
        const mintData = new Uint8Array(mintInfo.data);
        if (mintData.length >= 36) {
          const hasAuthority = new DataView(mintData.buffer, mintData.byteOffset).getUint32(0, true) === 1;
          if (hasAuthority) {
            const onChainAuthority = new PublicKey(mintData.slice(4, 36));
            if (!onChainAuthority.equals(mintAuthPk)) {
              // GH#1769: Authority mismatch — server cannot MintTo this mint.
              // Auto-resolve to a server-owned mirror for the same mainnet CA.
              // This handles: Token Factory mints, user-created devnet tokens, old-key mirrors.
              if (isSelfReferencingNativeMint || !mainnetCa || mainnetCa === mintAddress) {
                // No real mainnet CA available — cannot create a useful mirror.
                // Return the old error for truly unknown tokens.
                return NextResponse.json(
                  {
                    error: `Cannot mint tokens: this mint was not created by the Percolator mirror system. Use the devnet faucet page (/devnet-mint) to obtain tokens.`,
                    mintAuthority: onChainAuthority.toBase58(),
                    hint: "not_percolator_mint",
                  },
                  { status: 400 },
                );
              }
              // We have a real mainnet CA — try to find or create a server-owned mirror.
              console.info(
                `[devnet-airdrop] GH#1769: authority mismatch for ${mintAddress} ` +
                `(authority=${onChainAuthority.toBase58().slice(0, 8)}). ` +
                `Resolving server-owned mirror for mainnetCa=${mainnetCa}`,
              );
              const resolvedMint = await resolveServerOwnedDevnetMint(
                supabase,
                connection,
                mainnetCa,
                mintSigner,
                symbol,
                decimals,
              );
              if (!resolvedMint) {
                return NextResponse.json(
                  {
                    error: "Cannot mint tokens: mint authority mismatch and server could not create a mirror. Try the devnet faucet page (/devnet-mint).",
                    hint: "old_key_mirror",
                  },
                  { status: 400 },
                );
              }
              // Switch to the resolved server-owned mint for the rest of the flow.
              effectiveMintPk = new PublicKey(resolvedMint);
              effectiveMintAddress = resolvedMint;
            }
          } else {
            return NextResponse.json(
              { error: "This mint has no mint authority (fixed supply). Cannot airdrop new tokens." },
              { status: 400 },
            );
          }
        }
      } catch (authCheckErr) {
        // RPC error during authority check — log and surface as 503 (retryable) rather than
        // silently falling through to mintTo, which would fail on-chain and return a generic 500.
        const msg = authCheckErr instanceof Error ? authCheckErr.message : String(authCheckErr);
        console.warn("[devnet-airdrop] mint authority check failed:", msg);
        Sentry.captureException(authCheckErr, {
          tags: { endpoint: "/api/devnet-airdrop", step: "authority_check" },
          extra: { mintAddress, walletAddress },
        });
        return NextResponse.json(
          { error: "Could not verify mint authority due to RPC error. Please retry.", retryable: true },
          { status: 503 },
        );
      }

      // Derive user's ATA (using effectiveMintPk which may be the resolved server-owned mirror)
      const ata = await getAssociatedTokenAddress(effectiveMintPk, walletPk);
      let ataExists = false;
      try {
        await getAccount(connection, ata);
        ataExists = true;
      } catch {
        // ATA doesn't exist yet — will be created in tx
      }

      // 5. Build and send mint transaction.
      const tx = new Transaction();
      if (!ataExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            mintAuthPk, // payer
            ata,
            walletPk,
            effectiveMintPk,
          ),
        );
      }
      tx.add(createMintToInstruction(effectiveMintPk, ata, mintAuthPk, rawAmount));

      // Set recentBlockhash and feePayer before signing.
      // sendRawTransaction requires both fields to be set — unlike sendAndConfirmTransaction
      // which fetches the blockhash internally. Without this, serialize() throws
      // "Transaction recentBlockhash field is required", causing a 500.
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = mintAuthPk;

      // Sign using sealed signer and send raw.
      // sendAndConfirmTransaction() calls tx.sign(signers) internally which wipes all existing
      // signatures — including the one the sealed signer just applied. Use sendRawTransaction +
      // confirmTransaction instead (same pattern as auto-fund and devnet-mirror-mint).
      const signedTx = mintSigner.signTransaction(tx);
      try {
        sig = await withTimeout(
          (async () => {
            const txSig = await connection.sendRawTransaction(
              (signedTx as Transaction).serialize(),
            );
            await connection.confirmTransaction(txSig, "confirmed");
            return txSig;
          })(),
          30_000,
        );
      } catch (mintErr) {
        // Convert mint-authority program errors (spl-token error 0x4 = OwnerMismatch) to 400.
        // Any other error (network, timeout) re-throws to surface as 500 via outer catch.
        const errStr = mintErr instanceof Error ? mintErr.message : String(mintErr);
        const isAuthorityError =
          errStr.includes("owner does not match") ||
          errStr.includes("OwnerMismatch") ||
          errStr.includes("0x4") || // spl-token OwnerMismatch
          errStr.includes("custom program error: 0x4");
        if (isAuthorityError) {
          Sentry.captureException(mintErr, {
            tags: { endpoint: "/api/devnet-airdrop", step: "mint_authority_mismatch" },
            extra: { mintAddress: effectiveMintAddress, walletAddress },
          });
          // Don't re-throw — let the finally block release the claim, then return 400
          return NextResponse.json(
            {
              error:
                "Cannot mint tokens: mint authority mismatch. This mirror token was created with an old key and needs to be re-keyed. Please use the devnet faucet page (/devnet-mint) to obtain tokens.",
              hint: "old_key_mirror",
            },
            { status: 400 },
          );
        }
        throw mintErr; // re-throw non-authority errors (will 500 via outer catch)
      }
      mintSucceeded = true;
    } finally {
      // Release the claim slot on ANY failure so user isn't locked out 24h.
      // Wrapped in try/catch so a releaseClaim() throw doesn't mask the original
      // mint error and lose its stack trace from Sentry.
      if (!mintSucceeded && claimId !== undefined) {
        try {
          await releaseClaim(supabase, claimId);
        } catch (releaseErr) {
          Sentry.captureException(releaseErr, {
            tags: { endpoint: "/api/devnet-airdrop", step: "release_claim_finally" },
          });
        }
      }
    }

    // Claim slot is already recorded from step 2 — no separate recordClaim needed.
    const humanAmount = Number(rawAmount!) / 10 ** decimals;

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
