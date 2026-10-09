/**
 * POST /api/mobile/create-market
 *
 * Server-assisted transaction builder for mobile market creation (GH #80).
 *
 * The slab, LP portfolio, and matcher-context accounts are derived from the
 * deployer via `PublicKey.createWithSeed` (deployer pubkey + a per-request random
 * seed) so their addresses are deterministic without the server ever generating
 * or holding a keypair for them — no keypair is created, and the server never
 * signs anything.
 *
 * Flow:
 *  1. Client posts { deployer, mint, tier, name, oracle_mode, initial_price_e6 }
 *  2. Server derives the slab, LP-portfolio, and matcher-context addresses with
 *     createWithSeed (unsigned, deterministic — no keypairs involved)
 *  3. Server builds 5 UNSIGNED transactions (no server signature of any kind —
 *     every account, including the derived ones above, is authorized by the
 *     deployer's own signature via createAccountWithSeed)
 *  4. Returns base64-encoded unsigned txs + slab_address
 *  5. Mobile signs each tx with MWA (adds the deployer signature) and sends in order
 *  6. Mobile calls POST /api/markets to register the new market in the dashboard DB
 *
 * Security: no account private keys are generated or persisted, and the server never
 * partially-signs a transaction. The deployer field is validated as a valid Solana
 * pubkey. The endpoint uses an allowlist guard — only NEXT_PUBLIC_DEFAULT_NETWORK (or
 * NEXT_PUBLIC_SOLANA_NETWORK) === "devnet" is accepted; all other values (mainnet,
 * staging, unset) return 403 (GH#1950).
 */
import { marketAccountLen } from "@/lib/v22/layout";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  PublicKey,
  SystemProgram,
  Transaction,
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
  encodeSetNftProgramId,
  encodeInitMatcherCtx,
  encodeSetMatcherConfig,
  encodeInitUser,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_SET_MATCHER_CONFIG,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_INIT_USER,
  buildAccountMetas,
  WELL_KNOWN,
  buildIx,
  deriveVaultAuthority,
  deriveMatcherDelegate,
  deriveNftRegistry,
  MATCHER_CONTEXT_LEN,
  MAX_BACKING_BUCKET_EXPIRY_SLOT,
  v17MarketAccountLen,
  type SlabTierKey,
} from "@percolatorct/sdk";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { getConfig } from "@/lib/config";
import { getServerConnection } from "@/lib/server-rpc";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { getClientIp } from "@/lib/get-client-ip";
import {
  checkCreateMarketRateLimit,
  CREATE_MARKET_RATE_LIMIT,
} from "@/lib/create-market-rate-limit";
import * as Sentry from "@sentry/nextjs";
import { deriveMarketParams, leverageFromMarginBps } from "@/lib/market-params";
import { LAUNCH_ASSET_SLOTS, initialAssetGenerationFrontier } from "@/lib/create-market-args";
import { buildInitMatcherCtxArgs } from "@/lib/matcher-params";
import {
  buildMobileFundingIxs,
  mobileRequiredCollateral,
  MIN_INIT_MARKET_SEED,
  DEFAULT_LP_COLLATERAL,
  DEFAULT_INSURANCE,
} from "@/lib/mobile-market-funding-ixs";

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
  /** Token symbol (<= 20 chars). v2.2 only: the Earn share token's ticker derives from it (tag 122); absent = the generic share name. */
  symbol?: string;
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
      symbol,
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

    if (symbol !== undefined && (typeof symbol !== "string" || symbol.length > 20)) {
      return NextResponse.json({ error: "symbol must be a string of 20 characters or fewer" }, { status: 400 });
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
    // those fail InitMarket's (len-592-758)%1797==0 check and revert; 592 = header+config after the
    // 576-byte fee-split config). `tier` still selects the program ID above; the slab account length
    // is computed from the asset-slot capacity via the SDK's v17MarketAccountLen (SDK-derived offsets).
    // ONE slot capacity feeds all three places that must agree: the account length (here), InitMarket's
    // maxPortfolioAssets, and SetMatcherConfig's frontier (slots + 1). Same count the wizard launches with.
    const assetSlots = LAUNCH_ASSET_SLOTS;
    // Layout-aware: v2.2 (flag on) sizes by the v2.2 stride; flag off this is exactly v17MarketAccountLen(assetSlots).
    const slabDataSize = isDevnetV22Enabled() ? marketAccountLen(assetSlots) : v17MarketAccountLen(assetSlots);

    // Default margin/leverage params — conservative for new markets
    const initialMarginBps = 2000n; // 50% margin = 5× leverage

    // Risk params come from the SAME derivation the launch wizard uses. This
    // route previously hardcoded maxPriceMoveBpsPerSlot:4 / maxAccrualDtSlots:400
    // — a budget of 1600 against the ~800 the deployed program accepts at this
    // maintenance margin, so InitMarket rejected it — and initialised the
    // matcher with maxFillAbs = u128::MAX, the unlimited-LP configuration that
    // drained every devnet-1 market. See lib/market-params.ts.
    const derivedParams = deriveMarketParams(
      leverageFromMarginBps(Number(initialMarginBps)),
      DEFAULT_LP_COLLATERAL,
      priceE6,
    );

    // ── RPC & blockhash ───────────────────────────────────────────────────────
    const connection = getServerConnection("confirmed");
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");

    // ── Refreshable deployer-derived accounts ────────────────
  // Unique, non-secret seeds allow every account-creation transaction
  // to be authorized and refreshed using the deployer signature only.
  const accountNonce = randomBytes(12).toString("hex");
  const slabSeed = `s-${accountNonce}`;
  const lpPortfolioSeed = `p-${accountNonce}`;
  const matcherCtxSeed = `m-${accountNonce}`;

  const [slabPk, lpPortfolioPk, matcherCtxPk] = await Promise.all([
    PublicKey.createWithSeed(deployerPk, slabSeed, programId),
    PublicKey.createWithSeed(
      deployerPk,
      lpPortfolioSeed,
      programId,
    ),
    PublicKey.createWithSeed(
      deployerPk,
      matcherCtxSeed,
      matcherProgramId,
    ),
  ]);

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
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
  const createSlabIx = SystemProgram.createAccountWithSeed({
    fromPubkey: deployerPk,
    basePubkey: deployerPk,
    seed: slabSeed,
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
      maxPortfolioAssets: assetSlots,
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
      maxPriceMoveBpsPerSlot: String(derivedParams.maxPriceMoveBpsPerSlot),
      maxAccrualDtSlots: String(derivedParams.maxAccrualDtSlots),
      maxAbsFundingE9PerSlot: "1000",
      minFundingLifetimeSlots: "50",
      maxAccountBSettlementChunks: "10",
      maxBankruptCloseChunks: "10",
      maxBankruptCloseLifetimeSlots: "500",
      publicBChunkAtoms: "1000000",
      maintenanceFeePerSlot: "0",
    };
    const initMarketData = encodeInitMarket(v17InitArgs);

    // v18 InitMarket takes exactly 3 accounts [admin, slab, mint] — the vault ATA,
    // token program, clock, rent, vault PDA and system program that v17 required
    // were dropped (see ACCOUNTS_INIT_MARKET in the v18 SDK, and hooks/useCreateMarket.ts
    // M1). Passing the old 9-account array tripped the SDK's "Account count
    // mismatch: expected 3, got 9" guard at step 1 (GH#2542).
    const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, {
      admin: deployerPk,
      slab: slabPk,
      mint: mintPk,
    });
    const initMarketIx = buildIx({ programId, keys: initMarketKeys, data: initMarketData });

    // SetNftProgramId (tag 73, marketauth-gated) creates the per-market nft_registry
    // PDA. Without it, MintPositionNft/BurnPositionNft fail on-chain with Custom(26)
    // "nft_registry not owned by the percolator program" for every market this route
    // creates — the web launch wizard runs this in its M1 step (useCreateMarket.ts)
    // right after InitMarket; this route never did (GH#2542 follow-up). Unconditional
    // here (unlike the wizard's resume path) because this route always creates a
    // brand-new market — the registry can never already exist.
    const [nftRegistryPda] = deriveNftRegistry(programId, slabPk);
    const setNftProgramIdIx = buildIx({
      programId,
      keys: [
        { pubkey: deployerPk, isSigner: true, isWritable: true },
        { pubkey: slabPk, isSigner: false, isWritable: false },
        { pubkey: nftRegistryPda, isSigner: false, isWritable: true },
        { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
      ],
      data: encodeSetNftProgramId({ nftProgramId: PERCOLATOR_NFT_PROGRAM_ID }),
    });

    const tx0 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx0.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx0.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx0.add(createSlabIx, createVaultAtaIx, seedTransferIx, initMarketIx, setNftProgramIdIx);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 1: LP Portfolio Init (v17 replacement for pre-LP crank)
    // v17: PermissionlessCrank needs a portfolio at accounts[2] — which doesn't exist
    // before InitPortfolio. TX1 now creates the LP portfolio account + runs InitPortfolio.
    // The portfolio address is derived from the deployer and a unique seed.
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
    // Full portfolio length (9347): InitPortfolio reallocs up to it and adds no lamports, so an
    // undersized createAccount leaves the account below rent-exempt → InsufficientFundsForRent.
    const portfolioRent = await connection.getMinimumBalanceForRentExemption(portfolioAccountLen());

  const createPortfolioIx = SystemProgram.createAccountWithSeed({
    fromPubkey: deployerPk,
    basePubkey: deployerPk,
    seed: lpPortfolioSeed,
    newAccountPubkey: lpPortfolioPk,
      lamports: portfolioRent,
      space: portfolioAccountLen(),
      programId,
    });
    const initPortfolioIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_USER, {
        owner: deployerPk,
        market: slabPk,
        portfolio: lpPortfolioPk,
      }),
      data: encodeInitUser({}),
    });

    const tx1 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx1.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx1.add(createPortfolioIx, initPortfolioIx);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 2: createAccount(matcherCtx) + SetMatcherConfig + InitMatcherCtx
    // v17: encodeInitLP (tag 2) is REMOVED — throws removedInstruction().
    // Replacement: create matcher context account + call wrapper SetMatcherConfig
    // (tag 68) on the LP portfolio created in TX1 + call wrapper InitMatcherCtx
    // (tag 83), which CPIs into the matcher program itself (see the note below).
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════

    // Derive matcher delegate PDA: seeds = ["matcher", market, lpPortfolio, lpOwner, matcherProg, ctx]
    const [delegatePk] = deriveMatcherDelegate(
      programId, slabPk, lpPortfolioPk, deployerPk, matcherProgramId, matcherCtxPk,
    );

  const createCtxIx = SystemProgram.createAccountWithSeed({
    fromPubkey: deployerPk,
    basePubkey: deployerPk,
    seed: matcherCtxSeed,
    newAccountPubkey: matcherCtxPk,
      lamports: matcherCtxRent,
      space: MATCHER_CTX_SIZE,
      programId: matcherProgramId,
    });

    // SetMatcherConfig (tag 68) on the LP portfolio. MUST run before InitMatcherCtx
    // below — InitMatcherCtx verifies the (matcherProg, matcherCtx, matcherDelegate)
    // triple it's given against what SetMatcherConfig stored (see IX_TAG.InitMatcherCtx
    // in the SDK). Named-map form, matching hooks/useCreateMarket.ts M2.
    const setMatcherConfigIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_SET_MATCHER_CONFIG, {
        lpOwner: deployerPk,
        market: slabPk,
        lpPortfolio: lpPortfolioPk,
        matcherProg: matcherProgramId,
        matcherCtx: matcherCtxPk,
        matcherDelegate: delegatePk,
      }),
      // v18 fresh-market: LP is the first portfolio (portfolioId 1), matcher-seq 0
      // (InitUser just ran in TX1). assetGenerationFrontier = maxPortfolioAssets + 1
      // (initialAssetGenerationFrontier); tradeFeeCapBps 10000 = no practical cap; expirySlot born-immortal.
      data: encodeSetMatcherConfig({
        portfolioId: 1n,
        expectedSequence: 0n,
        assetGenerationFrontier: initialAssetGenerationFrontier(assetSlots),
        enabled: 1,
        tradeFeeCapBps: 10_000,
        expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT,
      }),
    });

    // InitMatcherCtx (tag 83) bootstraps the matcher context by CPIing into the
    // matcher program, signing as the matcherDelegate PDA via invoke_signed — that's
    // the ONLY way to satisfy the matcher program's lp_pda.is_signer check, since a
    // PDA can never sign a client-submitted instruction directly. This route
    // previously built a raw TransactionInstruction targeting the matcher program
    // (matcherProgramId) with delegatePk as a non-signer key, which cannot pass
    // that check on-chain — replaced with the wrapper CPI, matching
    // hooks/useCreateMarket.ts M2's initMatcherCtxIx (GH#2542 follow-up).
    const initMatcherCtxIx = buildIx({
      programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        lpOwner: deployerPk,
        market: slabPk,
        lpPortfolio: lpPortfolioPk,
        matcherCtx: matcherCtxPk,
        matcherProg: matcherProgramId,
        matcherDelegate: delegatePk,
      }),
      // Bounded fill/inventory, sized to LP capital — NOT u128::MAX (see derivedParams
      // above; this replaced the unlimited-LP config that drained devnet-1 markets).
      data: encodeInitMatcherCtx(buildInitMatcherCtxArgs(30, derivedParams.matcher)),
    });

    const tx2 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // Contains SetMatcherConfig (wrapper tag 68). The v17 wrapper installs a custom
    // 128KB heap allocator and aborts unless the tx requests the full heap frame.
    // Must be the FIRST instruction. (issue #176)
    tx2.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx2.add(createCtxIx, setMatcherConfigIx, initMatcherCtxIx);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX 3: DepositCollateral + TopUpInsurance + Crank (backing is TX4)
    // v17: Deposit account list = [owner, market, portfolio, sourceToken, vaultToken, tokenProgram]
    // No clock. Portfolio = lpPortfolioPk (created in TX1).
    // v17: PermissionlessCrank uses [owner, market, portfolio] — portfolio = lpPortfolioPk.
    // Signed by: deployer only
    // ═══════════════════════════════════════════════════════════════════════════
    // Deposit + insurance + crank (mandatory), and the two backing seeds as their
    // own transaction. Extracted to lib/mobile-market-funding-ixs.ts so the VALUES
    // can be asserted by decoding the instructions — the route itself cannot be
    // driven in a test (GH#2542), and source-text assertions let 21 of 33 mutants
    // through (GH#2595).
    const funding = buildMobileFundingIxs({
      programId,
      market: slabPk,
      lpPortfolio: lpPortfolioPk,
      deployer: deployerPk,
      userAta,
      vaultAta,
      collateralMint: mintPk, // v2.2 only: tag 74's account [6]
      shareSymbol: typeof symbol === "string" ? symbol : null, // v2.2 only: the share token's ticker (tag 122)
    });

    const tx3 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    // v17 wrapper installs a custom 128KB heap allocator and aborts unless the tx
    // requests the full heap frame. Must be the FIRST instruction. (issue #176)
    tx3.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx3.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx3.add(...funding.mandatory);

    // ═══════════════════════════════════════════════════════════════════════════
    // TX4: both backing domains, via CreateLpVault + DepositToLpVault x2 (the web
    // launch's C-1 path; GH#2749) — NON-FATAL by GH#2514 policy (GH#2595).
    //
    // Kept out of TX3 on purpose. Merging them would make a deliberately non-fatal
    // step fatal and would raise TX3's draw from 1,100 to 3,000 tokens, so an
    // under-funded wallet would revert the LP deposit on a launch that previously
    // succeeded. TX4 is atomic: if it does not land, nothing in it applied, the
    // market is still live with Empty buckets, and the creator (still marketauth)
    // can create the Earn vault later.
    // ═══════════════════════════════════════════════════════════════════════════
    const tx4 = new Transaction({ recentBlockhash: blockhash, feePayer: deployerPk });
    tx4.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
    tx4.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx4.add(...funding.backingSeeds);

    // Insurance LP mint creation removed — moved to percolator-stake program.
    // Markets are fully operational without it (TX 0-4 are sufficient).

    // ═══════════════════════════════════════════════════════════════════════════
    // Response — client signs each tx with MWA, sends in order, then calls
    // POST /api/markets to register in the dashboard DB.
    // ═══════════════════════════════════════════════════════════════════════════
    return NextResponse.json({
      slab_address: slabPk.toBase58(),
      /**
       * Total collateral TX0-TX4 draw from the deployer's token account, so the
       * client can check BEFORE asking anyone to sign (GH#2595).
       *
       * vault seed + LP deposit + insurance + ONE backing seed PER DOMAIN. Seeding
       * backing raised this from 1,600 to 3,600 tokens at the current 100%-of-LP
       * policy, and this route has no pre-fund step of its own.
       *
       * TOP LEVEL, not inside `registration`: that object is read only after every
       * transaction has succeeded, so a pre-flight figure is useless there — and
       * POST /api/markets authenticates over the whole registration body except
       * `nonce`/`signature` (lib/market-registration-auth.ts), so an added field
       * there can 401 a client that builds its signing payload from a fixed list.
       */
      required_collateral: mobileRequiredCollateral().toString(),
      /** Base64-encoded unsigned transactions. Mobile adds the deployer signature. */
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
      { error: "Market creation failed. Please try again later." },
      { status: 500 },
    );
  }
}
