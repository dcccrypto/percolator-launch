/**
 * POST /api/mobile/create-market
 *
 * Server-assisted transaction builder for mobile market creation (GH #80).
 *
 * Problem: Mobile cannot execute the 5-step on-chain deployment flow that the web
 * wizard does client-side. The slab and matcher-context keypairs must co-sign TX0
 * and TX2 respectively, which requires server-side key generation.
 *
 * Flow:
 *  1. Client posts { deployer, mint, tier, name, oracle_mode, initial_price_e6 }
 *  2. Server generates slab keypair + matcher-context keypair
 *  3. Server builds and partially-signs all 5 transactions (server signs with generated
 *     keypairs; deployer signature is left blank for mobile wallet to fill in)
 *  4. Returns base64-encoded partially-signed txs + slab_address
 *  5. Mobile signs each tx with MWA (adds deployer signature) and sends in order
 *  6. Mobile calls POST /api/markets to register the new market in the dashboard DB
 *
 * Security: server keypairs are ephemeral (never persisted). The deployer field is
 * validated as a valid Solana pubkey. This endpoint is devnet-only for beta.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  encodeInitLP,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodeKeeperCrank,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeSetOraclePriceCap,
  encodeUpdateConfig,
  encodeCreateInsuranceMint,
  deriveInsuranceLpMint,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_SET_ORACLE_PRICE_CAP,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  deriveLpPda,
  SLAB_TIERS,
  type SlabTierKey,
} from "@percolator/sdk";
import { getConfig, getRpcEndpoint } from "@/lib/config";
import { getClientIp } from "@/lib/get-client-ip";
import {
  checkCreateMarketRateLimit,
  CREATE_MARKET_RATE_LIMIT,
} from "@/lib/create-market-rate-limit";
import * as Sentry from "@sentry/nextjs";

/** Minimum token amount for vault seed transfer (matches on-chain guard). */
const MIN_INIT_MARKET_SEED = 500_000_000n;
/** Default LP collateral deposit (1,000 tokens raw with 6 decimals). */
const DEFAULT_LP_COLLATERAL = 1_000_000_000n;
/** Default insurance fund seed (100 tokens raw with 6 decimals). */
const DEFAULT_INSURANCE = 100_000_000n;
/** Matcher context account size in bytes. */
const MATCHER_CTX_SIZE = 320;
/** Admin oracle feed (all zeros = on-chain admin oracle). */
const ADMIN_ORACLE_FEED = "0".repeat(64);

function txToBase64(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

interface MobileCreateMarketBody {
  /** Deployer's Solana public key (base58). */
  deployer: string;
  /** Collateral token mint address (base58). */
  mint: string;
  /** Slab tier — controls max accounts and SOL rent cost. Default: "small". */
  tier?: SlabTierKey;
  /** Human-readable market name. */
  name?: string;
  /** Oracle mode. Only "admin" is supported for devnet beta. */
  oracle_mode?: "admin" | "hyperp" | "pyth";
  /** DEX pool address (base58). Required for hyperp mode; ignored for admin. */
  dex_pool_address?: string | null;
  /** Initial mark price in e6 format (price × 1_000_000). Default: "1000000" ($1.00). */
  initial_price_e6?: string;
}

export async function POST(req: NextRequest) {
  // ── Rate limit check: sliding-window 5 req/min per IP (#990, #PERC-577) ─
  const clientIp = getClientIp(req);
  const rl = await checkCreateMarketRateLimit(clientIp);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded — max 5 create-market requests per minute" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSecs),
          "X-RateLimit-Limit": String(CREATE_MARKET_RATE_LIMIT),
          "X-RateLimit-Remaining": "0",
          // seconds-until-reset (matches middleware.ts convention)
          "X-RateLimit-Reset": String(Math.max(0, rl.retryAfterSecs)),
        },
      },
    );
  }

  try {
    const body: MobileCreateMarketBody = await req.json();
    const {
      deployer,
      mint,
      tier = "small",
      name = "Mobile Market",
      oracle_mode = "admin",
      initial_price_e6 = "1000000",
    } = body;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!deployer || !mint) {
      return NextResponse.json(
        { error: "Missing required fields: deployer, mint" },
        { status: 400 },
      );
    }

    let deployerPk: PublicKey;
    let mintPk: PublicKey;
    try {
      deployerPk = new PublicKey(deployer);
    } catch {
      return NextResponse.json(
        { error: "Invalid deployer address — must be a valid Solana public key" },
        { status: 400 },
      );
    }
    try {
      mintPk = new PublicKey(mint);
    } catch {
      return NextResponse.json(
        { error: "Invalid mint address — must be a valid Solana public key" },
        { status: 400 },
      );
    }

    const validTiers: SlabTierKey[] = ["small", "medium", "large"];
    if (!validTiers.includes(tier)) {
      return NextResponse.json(
        { error: `Invalid tier. Must be one of: ${validTiers.join(", ")}` },
        { status: 400 },
      );
    }

    const validOracleModes = ["admin", "hyperp", "pyth"] as const;
    if (!validOracleModes.includes(oracle_mode as typeof validOracleModes[number])) {
      return NextResponse.json(
        { error: `Invalid oracle_mode. Must be one of: ${validOracleModes.join(", ")}` },
        { status: 400 },
      );
    }

    let priceE6: bigint;
    try {
      priceE6 = BigInt(initial_price_e6);
      if (priceE6 <= 0n) throw new Error("price must be > 0");
    } catch {
      return NextResponse.json(
        { error: "Invalid initial_price_e6 — must be a positive integer string" },
        { status: 400 },
      );
    }

    // ── Config & program selection ────────────────────────────────────────────
    const cfg = getConfig();
    const tierProgramId = cfg.programsBySlabTier?.[tier] ?? cfg.programId;
    const programId = new PublicKey(tierProgramId);
    const matcherProgramId = new PublicKey(cfg.matcherProgramId);

    const tierConfig = SLAB_TIERS[tier];
    const { dataSize: slabDataSize, maxAccounts } = tierConfig;

    // Default margin/leverage params — conservative for new markets
    const initialMarginBps = 2000n; // 50% margin = 5× leverage

    // ── RPC & blockhash ───────────────────────────────────────────────────────
    const rpcUrl = getRpcEndpoint();
    const connection = new Connection(rpcUrl, "confirmed");
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    // ── Ephemeral keypairs (server-side only, never persisted) ────────────────
    const slabKp = Keypair.generate();
    const matcherCtxKp = Keypair.generate();
    const slabPk = slabKp.publicKey;

    // ── PDAs & associated accounts ────────────────────────────────────────────
    const [vaultPda] = deriveVaultAuthority(programId, slabPk);
    const vaultAta = await getAssociatedTokenAddress(mintPk, vaultPda, true);
    const userAta = await getAssociatedTokenAddress(mintPk, deployerPk);
    const [insLpMint] = deriveInsuranceLpMint(programId, slabPk);
    const [vaultAuth] = deriveVaultAuthority(programId, slabPk);

    // ── Rent ──────────────────────────────────────────────────────────────────
    const [slabRent, matcherCtxRent] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(slabDataSize),
      connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE),
    ]);

    const now = Math.floor(Date.now() / 1000);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 0: createAccount(slab) + createATA(vaultAta) + seedTransfer + initMarket
    // Partially signed by: slabKp (server), deployer (mobile)
    // ═══════════════════════════════════════════════════════════════════════════
    const createSlabIx = SystemProgram.createAccount({
      fromPubkey: deployerPk,
      newAccountPubkey: slabPk,
      lamports: slabRent,
      space: slabDataSize,
      programId,
    });

    const createVaultAtaIx = createAssociatedTokenAccountInstruction(
      deployerPk,
      vaultAta,
      vaultPda,
      mintPk,
    );

    const seedTransferIx = createTransferInstruction(
      userAta,
      vaultAta,
      deployerPk,
      MIN_INIT_MARKET_SEED,
    );

    const initMarketData = encodeInitMarket({
      admin: deployerPk,
      collateralMint: mintPk,
      indexFeedId: ADMIN_ORACLE_FEED,
      maxStalenessSecs: "86400",
      confFilterBps: 0,
      invert: 0,
      unitScale: 0,
      initialMarkPriceE6: priceE6.toString(),
      warmupPeriodSlots: "100",
      maintenanceMarginBps: (initialMarginBps / 2n).toString(),
      initialMarginBps: initialMarginBps.toString(),
      tradingFeeBps: "30",
      maxAccounts: maxAccounts.toString(),
      newAccountFee: "1000000",
      riskReductionThreshold: "0",
      maintenanceFeePerSlot: "0",
      maxCrankStalenessSlots: "400",
      liquidationFeeBps: "100",
      liquidationFeeCap: "100000000000",
      liquidationBufferBps: "50",
      minLiquidationAbs: "1000000",
    });

    const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
      deployerPk,
      slabPk,
      mintPk,
      vaultAta,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
      WELL_KNOWN.rent,
      vaultPda,
      WELL_KNOWN.systemProgram,
    ]);
    const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

    const tx0 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx0.add(createSlabIx, createVaultAtaIx, seedTransferIx, initMarketIx);
    tx0.partialSign(slabKp); // server co-signs as the new slab account

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 1: SetOracleAuthority(user) + PushOraclePrice + SetOraclePriceCap +
    //        UpdateConfig + KeeperCrank
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════

    // 1a. SetOracleAuthority → deployer becomes oracle authority
    const setAuthToUserKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
      deployerPk,
      slabPk,
    ]);
    const setAuthToUserIx = buildIx({
      programId,
      keys: setAuthToUserKeys,
      data: encodeSetOracleAuthority({ newAuthority: deployerPk }),
    });

    // 1b. PushOraclePrice — push initial mark price
    const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [deployerPk, slabPk]);
    const pushIx = buildIx({
      programId,
      keys: pushKeys,
      data: encodePushOraclePrice({ priceE6: priceE6.toString(), timestamp: now.toString() }),
    });

    // 1c. SetOraclePriceCap — circuit breaker: max 1% change per update
    const priceCapKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_PRICE_CAP, [deployerPk, slabPk]);
    const priceCapIx = buildIx({
      programId,
      keys: priceCapKeys,
      data: encodeSetOraclePriceCap({ maxChangeE2bps: BigInt(10_000) }),
    });

    // 1d. UpdateConfig — funding rate params
    const updateConfigKeys = buildAccountMetas(ACCOUNTS_UPDATE_CONFIG, [deployerPk, slabPk]);
    const updateConfigIx = buildIx({
      programId,
      keys: updateConfigKeys,
      data: encodeUpdateConfig({
        fundingHorizonSlots: "3600",
        fundingKBps: "100",
        fundingInvScaleNotionalE6: "1000000000000",
        fundingMaxPremiumBps: "1000",
        fundingMaxBpsPerSlot: "10",
        threshFloor: "0",
        threshRiskBps: "500",
        threshUpdateIntervalSlots: "100",
        threshStepBps: "100",
        threshAlphaBps: "5000",
        threshMin: "0",
        threshMax: "1000000000000000000",
        threshMinStep: "0",
      }),
    });

    // 1e. KeeperCrank (pre-LP) — for admin oracle, oracle account = slabPk
    const crankKeys1 = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      deployerPk,
      slabPk,
      WELL_KNOWN.clock,
      slabPk, // admin oracle: oracle account is the slab itself
    ]);
    const crankIx1 = buildIx({
      programId,
      keys: crankKeys1,
      data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
    });

    const tx1 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx1.add(setAuthToUserIx, pushIx, priceCapIx, updateConfigIx, crankIx1);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 2: createAccount(matcherCtx) + InitLP
    // Partially signed by: matcherCtxKp (server), deployer (mobile)
    // ═══════════════════════════════════════════════════════════════════════════
    const createCtxIx = SystemProgram.createAccount({
      fromPubkey: deployerPk,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent,
      space: MATCHER_CTX_SIZE,
      programId: matcherProgramId,
    });

    const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
      deployerPk,
      slabPk,
      userAta,
      vaultAta,
      WELL_KNOWN.tokenProgram,
    ]);
    const initLpIx = buildIx({
      programId,
      keys: initLpKeys,
      data: encodeInitLP({
        matcherProgram: matcherProgramId,
        matcherContext: matcherCtxKp.publicKey,
        feePayment: "1000000",
      }),
    });

    const tx2 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx2.add(createCtxIx, initLpIx);
    tx2.partialSign(matcherCtxKp); // server co-signs as the new matcher context account

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 3: DepositCollateral + TopUpInsurance + PushOraclePrice +
    //        KeeperCrank (final) + SetOracleAuthority(crank)
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      deployerPk,
      slabPk,
      userAta,
      vaultAta,
      WELL_KNOWN.tokenProgram,
      WELL_KNOWN.clock,
    ]);
    const depositIx = buildIx({
      programId,
      keys: depositKeys,
      data: encodeDepositCollateral({ userIdx: 0, amount: DEFAULT_LP_COLLATERAL.toString() }),
    });

    const topupKeys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [
      deployerPk,
      slabPk,
      userAta,
      vaultAta,
      WELL_KNOWN.tokenProgram,
    ]);
    const topupIx = buildIx({
      programId,
      keys: topupKeys,
      data: encodeTopUpInsurance({ amount: DEFAULT_INSURANCE.toString() }),
    });

    // Push fresh price (timestamp + 5s to avoid duplication with TX1)
    const pushKeys2 = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [deployerPk, slabPk]);
    const pushIx2 = buildIx({
      programId,
      keys: pushKeys2,
      data: encodePushOraclePrice({
        priceE6: priceE6.toString(),
        timestamp: (now + 5).toString(),
      }),
    });

    const crankKeys3 = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
      deployerPk,
      slabPk,
      WELL_KNOWN.clock,
      slabPk, // admin oracle: oracle account is the slab
    ]);
    const crankIx3 = buildIx({
      programId,
      keys: crankKeys3,
      data: encodeKeeperCrank({ callerIdx: 65535, allowPanic: false }),
    });

    const tx3Instructions = [depositIx, topupIx, pushIx2, crankIx3];

    // Delegate oracle authority to the crank wallet so the keeper bot can push prices
    const crankWallet = cfg.crankWallet?.trim();
    if (crankWallet) {
      const crankPk = new PublicKey(crankWallet);
      const setAuthToCrankKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [
        deployerPk,
        slabPk,
      ]);
      tx3Instructions.push(
        buildIx({
          programId,
          keys: setAuthToCrankKeys,
          data: encodeSetOracleAuthority({ newAuthority: crankPk }),
        }),
      );
    }

    const tx3 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx3.add(...tx3Instructions);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 4: CreateInsuranceLpMint — permissionless insurance deposits
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
    const createMintKeys = buildAccountMetas(ACCOUNTS_CREATE_INSURANCE_MINT, [
      deployerPk,     // admin (signer)
      slabPk,          // slab
      insLpMint,       // ins_lp_mint (PDA, writable)
      vaultAuth,       // vault_authority
      mintPk,          // collateral_mint
      SystemProgram.programId,      // system_program
      WELL_KNOWN.tokenProgram,      // token_program
      WELL_KNOWN.rent,              // rent
      deployerPk,      // payer (signer, writable)
    ]);
    const createMintIx = buildIx({
      programId,
      keys: createMintKeys,
      data: encodeCreateInsuranceMint(),
    });

    const tx4 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx4.add(createMintIx);

    // ═══════════════════════════════════════════════════════════════════════════
    // Response — client signs each tx with MWA, sends in order, then calls
    // POST /api/markets to register in the dashboard DB.
    // ═══════════════════════════════════════════════════════════════════════════
    return NextResponse.json({
      slab_address: slabPk.toBase58(),
      /** Base64-encoded partially-signed transactions. Mobile adds deployer signature. */
      unsigned_txs: [tx0, tx1, tx2, tx3, tx4].map(txToBase64),
      /** Config for the POST /api/markets registration call after all txs succeed. */
      registration: {
        slab_address: slabPk.toBase58(),
        mint_address: mint,
        name,
        deployer,
        oracle_mode,
        max_leverage: Math.floor(10000 / Number(initialMarginBps)),
        trading_fee_bps: 30,
        lp_collateral: DEFAULT_LP_COLLATERAL.toString(),
        initial_price_e6: priceE6.toString(),
      },
      /** Block height after which the blockhash expires (~60s / 150 slots). */
      last_valid_block_height: lastValidBlockHeight,
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { endpoint: "/api/mobile/create-market" } });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
