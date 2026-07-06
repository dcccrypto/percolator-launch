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
 * validated as a valid Solana pubkey. The endpoint uses an allowlist guard — only
 * NEXT_PUBLIC_DEFAULT_NETWORK (or NEXT_PUBLIC_SOLANA_NETWORK) === "devnet" is
 * accepted; all other values (mainnet, staging, unset) return 403 (GH#1950).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  type InitMarketV17Args,
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodePermissionlessCrank,
  encodeMatcherInitPassive,
  encodeSetMatcherConfig,
  encodeInitUser,
  CrankAction,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  deriveMatcherDelegate,
  MATCHER_CONTEXT_LEN,
  v17MarketAccountLen,
  V17_PORTFOLIO_ACCOUNT_LEN,
  type SlabTierKey,
} from "@percolatorct/sdk";
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
// MATCHER_CTX_SIZE imported as MATCHER_CONTEXT_LEN from @percolatorct/sdk (= 320)
const MATCHER_CTX_SIZE = MATCHER_CONTEXT_LEN;
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
  /** Oracle mode. Only "admin" is implemented — "hyperp"/"pyth" are rejected (GH#1989). */
  oracle_mode?: string;
  /** DEX pool address (base58). Reserved for future hyperp mode; currently unused. */
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

  // GH#1950: allowlist-only guard — only devnet is permitted.
  // Reject any network that is not explicitly "devnet" (catches mainnet, staging,
  // misconfigured envs, and undefined deployments).
  const network =
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() ??
    process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim();
  if (network !== "devnet") {
    return NextResponse.json(
      {
        error:
          "Mobile create-market is only available on devnet. " +
          `Current network: ${network ?? "unset"}.`,
      },
      { status: 403 },
    );
  }

  try {
    const body: MobileCreateMarketBody = await req.json();
    const {
      deployer,
      mint,
      tier = "small",
      name: rawName = "Mobile Market",
      oracle_mode = "admin",
      initial_price_e6 = "1000000",
    } = body;

    // Validate name length — reject >64 chars with 400 rather than silently truncating (#998)
    const name = typeof rawName === "string" ? rawName : "Mobile Market";
    if (name.length > 64) {
      return NextResponse.json(
        { error: "name must be 64 characters or fewer" },
        { status: 400 },
      );
    }

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

    // GH#1989: Only "admin" oracle mode is implemented on-chain. Accepting
    // "hyperp" or "pyth" would write those values to DB metadata while the
    // actual on-chain instructions always build an admin-oracle market,
    // creating a trust-model mismatch between metadata and execution.
    if (oracle_mode !== "admin") {
      return NextResponse.json(
        {
          error:
            `Unsupported oracle_mode "${oracle_mode}". ` +
            `Only "admin" is currently supported for on-chain market initialization. ` +
            `"hyperp" and "pyth" modes are not yet implemented.`,
        },
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

    // v17 markets are dynamically sized by maxPortfolioAssets (NOT the v12 SLAB_TIERS byte counts —
    // those fail InitMarket's (len-448-758)%1797==0 check and revert). `tier` still selects the
    // program ID above; the slab account length is computed from the asset-slot capacity.
    const slabDataSize = v17MarketAccountLen(14);

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

    // ── Rent ──────────────────────────────────────────────────────────────────
    const [slabRent, matcherCtxRent] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(slabDataSize),
      connection.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE),
    ]);

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

    const v17InitArgs: InitMarketV17Args = {
      maxPortfolioAssets: 14,
      hMin: "100",
      hMax: "86400",
      initialPrice: priceE6.toString(),
      minNonzeroMmReq: "0",
      minNonzeroImReq: "0",
      maintenanceMarginBps: (initialMarginBps / 2n).toString(),
      initialMarginBps: initialMarginBps.toString(),
      maxTradingFeeBps: "30",
      tradeFeeBaseBps: "30",
      liquidationFeeBps: "100",
      liquidationFeeCap: "100000000000",
      minLiquidationAbs: "1000000",
      maxPriceMoveBpsPerSlot: "4",
      maxAccrualDtSlots: "400",
      maxAbsFundingE9PerSlot: "1000",
      minFundingLifetimeSlots: "50",
      maxAccountBSettlementChunks: "10",
      maxBankruptCloseChunks: "10",
      maxBankruptCloseLifetimeSlots: "500",
      publicBChunkAtoms: "1000000",
      maintenanceFeePerSlot: "0",
    };
    const initMarketData = encodeInitMarket(v17InitArgs);

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
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx0.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx0.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx0.add(createSlabIx, createVaultAtaIx, seedTransferIx, initMarketIx);
    tx0.partialSign(slabKp); // server co-signs as the new slab account

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 1: LP Portfolio Init (v17 replacement for pre-LP crank)
    // v17: PermissionlessCrank needs a portfolio at accounts[2] — which doesn't exist
    // before InitPortfolio. TX1 now creates the LP portfolio account + runs InitPortfolio.
    // The portfolio keypair is ephemeral (server-side only, never persisted).
    // Partially signed by: lpPortfolioKp (server), deployer (mobile)
    // ═══════════════════════════════════════════════════════════════════════════
    const lpPortfolioKp = Keypair.generate();
    const lpPortfolioPk = lpPortfolioKp.publicKey;
    // Full portfolio length (9347): InitPortfolio reallocs up to it and adds no lamports, so an
    // undersized createAccount leaves the account below rent-exempt → InsufficientFundsForRent.
    const portfolioRent = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);

    const createPortfolioIx = SystemProgram.createAccount({
      fromPubkey: deployerPk,
      newAccountPubkey: lpPortfolioPk,
      lamports: portfolioRent,
      space: V17_PORTFOLIO_ACCOUNT_LEN,
      programId,
    });
    const initPortfolioIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, [
        deployerPk,
        slabPk,
        lpPortfolioPk,
      ]),
      data: encodeInitUser({}),
    });

    const tx1 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx1.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx1.add(createPortfolioIx, initPortfolioIx);
    tx1.partialSign(lpPortfolioKp); // server co-signs as the new portfolio account

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 2: createAccount(matcherCtx) + matcher init passive + SetMatcherConfig
    // v17: encodeInitLP (tag 2) is REMOVED — throws removedInstruction().
    // Replacement: create matcher context account + call matcher program (InitPassive) +
    // call wrapper SetMatcherConfig (tag 68) on the LP portfolio created in TX1.
    // Partially signed by: matcherCtxKp (server), deployer (mobile)
    // ═══════════════════════════════════════════════════════════════════════════

    // Derive matcher delegate PDA: seeds = ["matcher", market, lpPortfolio, lpOwner, matcherProg, ctx]
    const [delegatePk] = deriveMatcherDelegate(
      programId, slabPk, lpPortfolioPk, deployerPk, matcherProgramId, matcherCtxKp.publicKey,
    );

    const createCtxIx = SystemProgram.createAccount({
      fromPubkey: deployerPk,
      newAccountPubkey: matcherCtxKp.publicKey,
      lamports: matcherCtxRent,
      space: MATCHER_CTX_SIZE,
      programId: matcherProgramId,
    });

    // Call matcher program: [delegate(ro), ctx(w)] + encodeMatcherInitPassive
    const matcherInitIx = new TransactionInstruction({
      programId: matcherProgramId,
      keys: [
        { pubkey: delegatePk, isSigner: false, isWritable: false },
        { pubkey: matcherCtxKp.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(encodeMatcherInitPassive({ maxFillAbs: BigInt("340282366920938463463374607431768211455") })),
    });

    // SetMatcherConfig (tag 68) on the LP portfolio
    // Accounts: [lpOwner(s), market(ro), lpPortfolio(w), matcherProg(ro), matcherCtx(ro), delegate(ro)]
    const setMatcherConfigIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, [
        deployerPk,
        slabPk,
        lpPortfolioPk,
        matcherProgramId,
        matcherCtxKp.publicKey,
        delegatePk,
      ]),
      data: encodeSetMatcherConfig({ enabled: 1 }),
    });

    const tx2 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // Contains SetMatcherConfig (wrapper tag 68). The v17 wrapper installs a custom
    // 128KB heap allocator and aborts unless the tx requests the full heap frame.
    // Must be the FIRST instruction. (issue #176)
    tx2.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx2.add(createCtxIx, matcherInitIx, setMatcherConfigIx);
    tx2.partialSign(matcherCtxKp); // server co-signs as the new matcher context account

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 3: DepositCollateral + TopUpInsurance + PermissionlessCrank (final)
    // v17: Deposit account list = [owner, market, portfolio, sourceToken, vaultToken, tokenProgram]
    // No clock. Portfolio = lpPortfolioPk (created in TX1).
    // v17: PermissionlessCrank uses [owner, market, portfolio] — portfolio = lpPortfolioPk.
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
    const vaultTokenAta = await getAssociatedTokenAddress(mintPk, vaultPda, true);

    // v17 Deposit: [owner(s,w), market(w), portfolio(w), sourceToken(w), vaultToken(w), tokenProgram]
    const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
      deployerPk,
      slabPk,
      lpPortfolioPk,
      userAta,
      vaultTokenAta,
      WELL_KNOWN.tokenProgram,
    ]);
    const depositIx = buildIx({
      programId,
      keys: depositKeys,
      data: encodeDepositCollateral({ amount: DEFAULT_LP_COLLATERAL.toString() }),
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

    // v17 PermissionlessCrank: [owner(s,w), market(w), portfolio(w)] (no oracle tail for admin oracle)
    const crankKeys3 = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
      deployerPk,
      slabPk,
      lpPortfolioPk,
    ]);
    const crankIx3 = buildIx({
      programId,
      keys: crankKeys3,
      data: encodePermissionlessCrank({ action: CrankAction.FeeSweep, assetIndex: 0, nowSlot: 0n, closeQ: 0n, feeBps: 0n, recoveryReason: 0 }),
    });

    const tx3 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx3.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx3.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx3.add(depositIx, topupIx, crankIx3);

    // Insurance LP mint creation removed — moved to percolator-stake program.
    // Markets are fully operational without it (TX 0-3 are sufficient).

    // ═══════════════════════════════════════════════════════════════════════════
    // Response — client signs each tx with MWA, sends in order, then calls
    // POST /api/markets to register in the dashboard DB.
    // ═══════════════════════════════════════════════════════════════════════════
    return NextResponse.json({
      slab_address: slabPk.toBase58(),
      /** Base64-encoded partially-signed transactions. Mobile adds deployer signature. */
      unsigned_txs: [tx0, tx1, tx2, tx3].map(txToBase64),
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
      { error: "Market creation failed. Please try again later." },
      { status: 500 },
    );
  }
}
