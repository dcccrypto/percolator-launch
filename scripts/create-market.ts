/**
 * Production Market Creation Script — Percolator
 *
 * Executes five transactions in sequence to bootstrap a new SOL/USDC perp market:
 *   TX1: InitMarket — allocate slab + initialize market with RiskParams (312 bytes)
 *   TX2: SetDexPool — pin the Raydium/PumpSwap DEX pool for the Hyperp oracle
 *   TX3: InitLP     — initialize LP slot 0 with seed deposit
 *   TX4: InitMatcherCtx — CPI-initialize the matcher context for LP 0
 *   TX5: TopUpInsurance — optional; seed the insurance fund
 *
 * Usage:
 *   npx tsx scripts/create-market.ts [--network mainnet|devnet] [--keypair /path/to/key.json]
 *
 * Environment variables (override CLI args):
 *   RPC_URL          — Solana RPC endpoint
 *   KEYPAIR_PATH     — Path to admin keypair JSON
 *   NETWORK          — "mainnet" | "devnet"
 *   COLLATERAL_MINT  — Override USDC mint address
 *   DEX_POOL         — DEX pool address for Hyperp oracle
 *   INITIAL_PRICE_E6 — Initial mark price in e6 units (default: 150_000_000 = $150)
 *   SEED_DEPOSIT     — LP seed deposit in USDC atomic units (default: 250_000_000 = 250 USDC)
 *   INSURANCE_AMOUNT — Insurance fund seed (default: 0, skips TX5)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// SDK encoders — these are the canonical source of truth for instruction layout.
// encodeInitMarket produces exactly 312 bytes (incl. 3 new fields: minInitialDeposit,
// minNonzeroMmReq, minNonzeroImReq) which were added after v5.
import {
  encodeInitMarket,
  encodeSetDexPool,
  encodeInitLP,
  encodeInitMatcherCtx,
  encodeTopUpInsurance,
  encodeTopUpKeeperFund,
  encodeSetOracleAuthority,
} from "@percolator/sdk";
import {
  buildAccountMetas,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_INIT_MATCHER_CTX,
  ACCOUNTS_TOPUP_INSURANCE,
} from "@percolator/sdk";

// ============================================================================
// Program IDs
// ============================================================================

const PROGRAM_ID_MAINNET = new PublicKey(
  "ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv",
);
const PROGRAM_ID_DEVNET = new PublicKey(
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
);
const MATCHER_PROG_ID = new PublicKey(
  "DHP6DtwXP1yJsz8YzfoeigRFPB979gzmumkmCxDLSkUX",
);

const USDC_MAINNET = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);
const USDC_DEVNET = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

// ============================================================================
// Slab constants
// ============================================================================

// V12_1 slab sizes: ENGINE_OFF=648, BITMAP_OFF=1016, ACCOUNT_SIZE=320
// Computed via SDK's computeSlabSize (verified against compile-time assertions)
// SBF layout differs from x86_64 due to i128 alignment. These values are
// from the deployed program's SLAB_LEN constant (verified via sol_log_64).
const SLAB_SIZE_MEDIUM = 290_120; // maxAccounts=1024 (V12_1, SBF alignment)
const SLAB_SIZE_SMALL  = 73_544;  // maxAccounts=256  (V12_1, SBF alignment, estimated)

// Matcher context account size (fixed, per matcher program)
const MATCHER_CTX_SIZE = 320;

// ============================================================================
// RiskParams defaults — SOL/USDC perp (Hyperp oracle mode)
// ============================================================================

const DEFAULT_RISK_PARAMS = {
  warmupPeriodSlots:      150n,            // ~1 minute at 2.5s/slot
  maintenanceMarginBps:   500n,            // 5%
  initialMarginBps:       1000n,           // 10% = 10x max leverage
  tradingFeeBps:          10n,             // 0.1%
  maxAccounts:            1024n,           // medium tier
  newAccountFee:          1_000_000n,      // 1 USDC (u128)
  maintenanceFeePerSlot:  0n,              // disabled (u128)
  maxCrankStalenessSlots: 300n,            // 5 minutes
  liquidationFeeBps:      50n,             // 0.5%
  liquidationFeeCap:      100_000_000n,    // 100 USDC (u128)
  minLiquidationAbs:      100n,            // lowered from 1_000_000 (u128)
  minInitialDeposit:      10_000_000n,     // 10 USDC (u128)
  minNonzeroMmReq:        100_000n,        // 0.1 USDC — must be > 0 (u128)
  minNonzeroImReq:        500_000n,        // 0.5 USDC — must be > mmReq, <= minInitialDeposit (u128)
  insuranceFloor:         0n,              // no floor (u128)
} as const;

// Fields between header and RiskParams (immutable after init)
const DEFAULT_INIT_EXTRA = {
  maxMaintenanceFeePerSlot: 1_000_000_000n, // ~1 USDC/slot ceiling (u128, must be > 0)
  maxInsuranceFloor:        1_000_000_000_000n, // 1M USDC ceiling (u128, must be > 0)
  minOraclePriceCap:        500n,          // 5% min price cap (u64, e2bps)
} as const;

// InitMatcherCtx defaults — passive vAMM for LP slot 0
const DEFAULT_MATCHER_CTX = {
  lpIdx:                0,
  kind:                 0,        // Passive
  tradingFeeBps:        30,       // 0.30%
  baseSpreadBps:        10,
  maxTotalBps:          200,
  impactKBps:           100,
  liquidityNotionalE6:  1_000_000_000n,          // $1,000 notional
  maxFillAbs:           100_000_000_000_000n,     // very large = no per-fill limit
  maxInventoryAbs:      10_000_000n,              // 10 USDC max inventory
  feeToInsuranceBps:    2000,
  skewSpreadMultBps:    5000,
} as const;

// ============================================================================
// CLI / env config
// ============================================================================

interface MarketConfig {
  network: "mainnet" | "devnet";
  rpcUrl: string;
  keypairPath: string;
  collateralMint: PublicKey;
  programId: PublicKey;
  dexPoolAddress: PublicKey;
  initialMarkPriceE6: bigint;
  seedDepositAmount: bigint;
  insuranceAmount: bigint;
  slabSize: number;
}

function parseArgs(): MarketConfig {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const network = (get("--network") ?? process.env.NETWORK ?? "mainnet") as
    | "mainnet"
    | "devnet";

  const defaultRpc =
    network === "mainnet"
      ? "https://api.mainnet-beta.solana.com"
      : "https://api.devnet.solana.com";

  const rpcUrl = get("--rpc") ?? process.env.RPC_URL ?? defaultRpc;

  const keypairPath =
    get("--keypair") ??
    process.env.KEYPAIR_PATH ??
    path.join(
      process.env.HOME!,
      ".percolator-mainnet",
      "keys",
      "deploy-authority.json",
    );

  const collateralMintStr =
    get("--collateral-mint") ?? process.env.COLLATERAL_MINT;
  const collateralMint = collateralMintStr
    ? new PublicKey(collateralMintStr)
    : network === "mainnet"
      ? USDC_MAINNET
      : USDC_DEVNET;

  const programId =
    network === "mainnet" ? PROGRAM_ID_MAINNET : PROGRAM_ID_DEVNET;

  const dexPoolStr =
    get("--dex-pool") ?? process.env.DEX_POOL;
  if (!dexPoolStr) {
    console.error(
      "ERROR: --dex-pool or DEX_POOL env var is required (Raydium/PumpSwap pool address)",
    );
    process.exit(1);
  }
  const dexPoolAddress = new PublicKey(dexPoolStr);

  const initialMarkPriceE6 = BigInt(
    get("--initial-price-e6") ?? process.env.INITIAL_PRICE_E6 ?? "150000000",
  );

  const seedDepositAmount = BigInt(
    get("--seed-deposit") ?? process.env.SEED_DEPOSIT ?? "250000000",
  );

  const insuranceAmount = BigInt(
    get("--insurance") ?? process.env.INSURANCE_AMOUNT ?? "0",
  );

  const slabSize = SLAB_SIZE_MEDIUM;

  return {
    network,
    rpcUrl,
    keypairPath,
    collateralMint,
    programId,
    dexPoolAddress,
    initialMarkPriceE6,
    seedDepositAmount,
    insuranceAmount,
    slabSize,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function sendTx(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
    maxRetries: 3,
  });

  console.log(`  ${label}: https://solscan.io/tx/${sig}`);
  return sig;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cfg = parseArgs();

  console.log("========== Percolator Market Creation ==========");
  console.log(`Network:         ${cfg.network}`);
  console.log(`RPC:             ${cfg.rpcUrl}`);
  console.log(`Admin keypair:   ${cfg.keypairPath}`);
  console.log(`Program:         ${cfg.programId.toBase58()}`);
  console.log(`Collateral mint: ${cfg.collateralMint.toBase58()}`);
  console.log(`DEX pool:        ${cfg.dexPoolAddress.toBase58()}`);
  console.log(`Initial price:   $${Number(cfg.initialMarkPriceE6) / 1_000_000}`);
  console.log(`Seed deposit:    ${Number(cfg.seedDepositAmount) / 1_000_000} USDC`);
  console.log(
    `Insurance seed:  ${Number(cfg.insuranceAmount) / 1_000_000} USDC${cfg.insuranceAmount === 0n ? " (skipping TX5)" : ""}`,
  );
  console.log("================================================\n");

  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const admin = loadKeypair(cfg.keypairPath);
  console.log(`Admin public key: ${admin.publicKey.toBase58()}`);

  // Pre-flight checks
  const adminSol = await conn.getBalance(admin.publicKey);
  console.log(`Admin SOL:        ${(adminSol / 1e9).toFixed(4)} SOL`);
  const adminAtaInfo = await conn.getAccountInfo(
    await getAssociatedTokenAddress(cfg.collateralMint, admin.publicKey),
  );
  const adminUsdc = adminAtaInfo
    ? Number(Buffer.from(adminAtaInfo.data).readBigUInt64LE(64)) / 1e6
    : 0;
  console.log(`Admin USDC:       ${adminUsdc.toFixed(2)} USDC`);
  const neededUsdc = Number(cfg.seedDepositAmount + cfg.insuranceAmount) / 1e6;
  if (adminUsdc < neededUsdc) {
    console.error(`ERROR: Need ${neededUsdc} USDC but only have ${adminUsdc.toFixed(2)}. Fund the wallet first.`);
    process.exit(1);
  }

  // Generate fresh keypairs for slab and matcher context
  const slab = Keypair.generate();
  const matcherCtx = Keypair.generate();

  // Derive vault PDA
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), slab.publicKey.toBuffer()],
    cfg.programId,
  );

  // Derive LP slot 0 PDA
  const lpIdxBuf = Buffer.alloc(2);
  lpIdxBuf.writeUInt16LE(0, 0);
  const [lpPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lp"), slab.publicKey.toBuffer(), lpIdxBuf],
    cfg.programId,
  );

  // Derive keeper fund PDA
  const [keeperFundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("keeper_fund"), slab.publicKey.toBuffer()],
    cfg.programId,
  );

  // ATAs
  const vaultAta = await getAssociatedTokenAddress(
    cfg.collateralMint,
    vaultPda,
    true, // allowOwnerOffCurve=true for PDAs
  );
  const adminAta = await getAssociatedTokenAddress(
    cfg.collateralMint,
    admin.publicKey,
  );

  console.log(`Slab:            ${slab.publicKey.toBase58()}`);
  console.log(`Matcher ctx:     ${matcherCtx.publicKey.toBase58()}`);
  console.log(`Vault PDA:       ${vaultPda.toBase58()}`);
  console.log(`Vault ATA:       ${vaultAta.toBase58()}`);
  console.log(`LP PDA (idx=0):  ${lpPda.toBase58()}`);
  console.log(`Keeper fund:     ${keeperFundPda.toBase58()}`);
  console.log();

  // ──────────────────────────────────────────────────────────────────────────
  // TX1: InitMarket
  //   - SystemProgram.createAccount (slab, SLAB_SIZE bytes, rent-exempt)
  //   - Create vault ATA if needed
  //   - InitMarket instruction (312 bytes, all 25 RiskParams fields)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("TX1: InitMarket (create slab + init market with RiskParams)...");

  const slabRent = await conn.getMinimumBalanceForRentExemption(cfg.slabSize);

  const initMarketData = encodeInitMarket({
    admin: admin.publicKey,
    collateralMint: cfg.collateralMint,
    // Hyperp mode: all-zeros feed ID (program validates against DEX pool set in TX2)
    indexFeedId:
      "0000000000000000000000000000000000000000000000000000000000000000",
    // maxStalenessSecs: not used in Hyperp mode but required field
    maxStalenessSecs: 120n,
    confFilterBps: 0,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: cfg.initialMarkPriceE6,
    ...DEFAULT_INIT_EXTRA,
    ...DEFAULT_RISK_PARAMS,
  });

  // Log instruction size for audit trail. The SDK's own encoder validates length
  // internally — this message helps catch SDK version drift when reviewing logs.
  console.log(
    `  encodeInitMarket: ${initMarketData.length} bytes ` +
      `(expected 352 — header + 3 extra fields + RiskParams with minInitialDeposit/minNonzeroMmReq/minNonzeroImReq)`,
  );

  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  // Create the slab account (program-owned, rent-exempt)
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: slab.publicKey,
      lamports: slabRent,
      space: cfg.slabSize,
      programId: cfg.programId,
    }),
  );
  // Create vault ATA if it doesn't exist
  tx1.add(
    createAssociatedTokenAccountInstruction(
      admin.publicKey,
      vaultAta,
      vaultPda,
      cfg.collateralMint,
    ),
  );
  // InitMarket instruction (tag 0)
  // Pass 11 accounts to also create keeper fund PDA (PERC-623):
  //   [0] admin, [1] slab, [2] mint, [3] vault, [4] tokenProgram,
  //   [5] clock, [6] rent, [7] dummyAta, [8] systemProgram,
  //   [9] keeperFundPda (writable), [10] systemProgram (for PDA creation)
  tx1.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        ...buildAccountMetas(ACCOUNTS_INIT_MARKET, {
          admin: admin.publicKey,
          slab: slab.publicKey,
          mint: cfg.collateralMint,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: SYSVAR_CLOCK_PUBKEY,
          rent: SYSVAR_RENT_PUBKEY,
          dummyAta: adminAta,
          systemProgram: SystemProgram.programId,
        }),
        // Extra accounts for keeper fund PDA creation
        { pubkey: keeperFundPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(initMarketData),
    }),
  );

  let sig1: string;
  try {
    sig1 = await sendTx(conn, tx1, [admin, slab], "TX1");
  } catch (e) {
    console.error("TX1 FAILED (InitMarket):", e instanceof Error ? e.message : e);
    console.error("Nothing was created on-chain — safe to retry.");
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX2: SetDexPool — pin the DEX pool for Hyperp oracle
  // ──────────────────────────────────────────────────────────────────────────
  console.log("TX2: SetDexPool (pin DEX pool for Hyperp oracle)...");

  const tx2 = new Transaction();
  tx2.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx2.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: slab.publicKey, isSigner: false, isWritable: true },
        { pubkey: cfg.dexPoolAddress, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(encodeSetDexPool({ pool: cfg.dexPoolAddress })),
    }),
  );

  let sig2: string;
  try {
    sig2 = await sendTx(conn, tx2, [admin], "TX2");
  } catch (e) {
    console.error("TX2 FAILED (SetDexPool):", e instanceof Error ? e.message : e);
    console.error(
      `Slab created: ${slab.publicKey.toBase58()} — use close-orphan-slab.ts to reclaim rent.`,
    );
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX3: InitLP — initialize LP slot 0 with seed deposit
  //   Also creates the matcher context keypair account.
  // ──────────────────────────────────────────────────────────────────────────
  console.log(
    `TX3: InitLP (seed deposit: ${Number(cfg.seedDepositAmount) / 1_000_000} USDC)...`,
  );

  const ctxRent = await conn.getMinimumBalanceForRentExemption(MATCHER_CTX_SIZE);

  const tx3 = new Transaction();
  tx3.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx3.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  // Pre-allocate the matcher context account (InitMatcherCtx in TX4 will fill it)
  tx3.add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: matcherCtx.publicKey,
      lamports: ctxRent,
      space: MATCHER_CTX_SIZE,
      programId: MATCHER_PROG_ID,
    }),
  );
  // InitLP instruction (tag 2): connects LP slot to matcher, transfers seed deposit
  // 6 accounts: [user(signer,writable), slab(writable), userAta(writable), vault(writable), tokenProgram, clock]
  tx3.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab.publicKey, isSigner: false, isWritable: true },
        { pubkey: adminAta, isSigner: false, isWritable: true },
        { pubkey: vaultAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        encodeInitLP({
          matcherProgram: MATCHER_PROG_ID,
          matcherContext: matcherCtx.publicKey,
          feePayment: cfg.seedDepositAmount,
        }),
      ),
    }),
  );

  let sig3: string;
  try {
    sig3 = await sendTx(conn, tx3, [admin, matcherCtx], "TX3");
  } catch (e) {
    console.error("TX3 FAILED (InitLP):", e instanceof Error ? e.message : e);
    console.error(
      `Slab created: ${slab.publicKey.toBase58()}\n` +
        `DEX pool set. Use close-orphan-slab.ts if you need to abort.`,
    );
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX4: InitMatcherCtx — CPI-initialize matcher context for LP 0
  // ──────────────────────────────────────────────────────────────────────────
  console.log("TX4: InitMatcherCtx (initialize matcher for LP slot 0)...");

  const tx4 = new Transaction();
  tx4.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx4.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx4.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: buildAccountMetas(ACCOUNTS_INIT_MATCHER_CTX, {
        admin: admin.publicKey,
        slab: slab.publicKey,
        matcherCtx: matcherCtx.publicKey,
        matcherProg: MATCHER_PROG_ID,
        lpPda,
      }),
      data: Buffer.from(encodeInitMatcherCtx(DEFAULT_MATCHER_CTX)),
    }),
  );

  let sig4: string;
  try {
    sig4 = await sendTx(conn, tx4, [admin], "TX4");
  } catch (e) {
    console.error(
      "TX4 FAILED (InitMatcherCtx):",
      e instanceof Error ? e.message : e,
    );
    console.error(
      `Market is partially initialized. LP slot 0 exists but matcher ctx is not set.\n` +
        `Slab: ${slab.publicKey.toBase58()}\n` +
        `Matcher ctx: ${matcherCtx.publicKey.toBase58()}\n` +
        `Run fix-lp-matcher.ts to retry TX4 only.`,
    );
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX5: TopUpInsurance — optional, seeds the insurance fund
  // ──────────────────────────────────────────────────────────────────────────
  let sig5: string | null = null;
  if (cfg.insuranceAmount > 0n) {
    console.log(
      `TX5: TopUpInsurance (${Number(cfg.insuranceAmount) / 1_000_000} USDC)...`,
    );

    const tx5 = new Transaction();
    tx5.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
    tx5.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx5.add(
      new TransactionInstruction({
        programId: cfg.programId,
        keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
          user: admin.publicKey,
          slab: slab.publicKey,
          userAta: adminAta,
          vault: vaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }),
        data: Buffer.from(
          encodeTopUpInsurance({ amount: cfg.insuranceAmount }),
        ),
      }),
    );

    try {
      sig5 = await sendTx(conn, tx5, [admin], "TX5");
    } catch (e) {
      // Non-fatal: market is fully functional without insurance seed
      console.warn(
        "TX5 WARNING (TopUpInsurance):",
        e instanceof Error ? e.message : e,
      );
      console.warn(
        "Market is live but has no insurance fund seed. Run top-up separately.",
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX6: TopUpKeeperFund — seed the keeper fund with SOL
  //   InitMarket already created the PDA with minimum rent, but we add more
  //   so the keeper earns rewards for cranking (0.001 SOL per crank).
  // ──────────────────────────────────────────────────────────────────────────
  const KEEPER_FUND_SEED_SOL = 0.1; // 0.1 SOL = 100 cranks worth of rewards
  const keeperFundLamports = BigInt(Math.floor(KEEPER_FUND_SEED_SOL * 1e9));

  console.log(`TX6: TopUpKeeperFund (${KEEPER_FUND_SEED_SOL} SOL)...`);
  const tx6 = new Transaction();
  tx6.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx6.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx6.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: slab.publicKey, isSigner: false, isWritable: true },
        { pubkey: keeperFundPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        encodeTopUpKeeperFund({ amount: keeperFundLamports }),
      ),
    }),
  );

  let sig6: string | null = null;
  try {
    sig6 = await sendTx(conn, tx6, [admin], "TX6");
  } catch (e) {
    console.warn("TX6 WARNING (TopUpKeeperFund):", e instanceof Error ? e.message : e);
    console.warn("Market is live but keeper fund has minimum balance only.");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TX7: SetOracleAuthority — set keeper as oracle authority for PushOraclePrice fallback
  // ──────────────────────────────────────────────────────────────────────────
  console.log("TX7: SetOracleAuthority (set keeper as fallback oracle authority)...");
  const tx7 = new Transaction();
  tx7.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
  tx7.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx7.add(
    new TransactionInstruction({
      programId: cfg.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: slab.publicKey, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(
        encodeSetOracleAuthority({ newAuthority: admin.publicKey }),
      ),
    }),
  );

  let sig7: string | null = null;
  try {
    sig7 = await sendTx(conn, tx7, [admin], "TX7");
  } catch (e) {
    console.warn("TX7 WARNING (SetOracleAuthority):", e instanceof Error ? e.message : e);
    console.warn("Market works without this but PushOraclePrice fallback is unavailable.");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Save market config to file
  // ──────────────────────────────────────────────────────────────────────────
  const marketJson = {
    programId: cfg.programId.toBase58(),
    slabAddress: slab.publicKey.toBase58(),
    matcherCtxAddress: matcherCtx.publicKey.toBase58(),
    keeperFundPda: keeperFundPda.toBase58(),
    lpPda: lpPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    collateralMint: cfg.collateralMint.toBase58(),
    dexPool: cfg.dexPoolAddress.toBase58(),
    network: cfg.network,
    createdAt: new Date().toISOString(),
    transactions: { sig1, sig2, sig3, sig4, sig5, sig6, sig7 },
  };

  const outFile = path.join(
    process.cwd(),
    `market-${cfg.network}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(outFile, JSON.stringify(marketJson, null, 2));
  console.log(`\nMarket config saved to: ${outFile}`);

  // ──────────────────────────────────────────────────────────────────────────
  // NOTE: You must manually insert this market into Supabase for the
  // frontend and indexer to display it properly. Example SQL:
  //
  //   INSERT INTO markets (slab_address, symbol, name, collateral_mint,
  //     dex_pool_address, oracle_mode, program_id, network)
  //   VALUES ('<slab>', 'SOL-PERP', 'SOL/USDC Perpetual', '<mint>',
  //     '<dex_pool>', 'hyperp', '<program_id>', '<network>');
  //
  // Without this row, the market appears nameless and is not the default
  // trading pair on the frontend.
  // ──────────────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n========== MARKET CREATED SUCCESSFULLY ==========");
  console.log(`Network:         ${cfg.network}`);
  console.log(`Slab:            ${slab.publicKey.toBase58()}`);
  console.log(`Matcher ctx:     ${matcherCtx.publicKey.toBase58()}`);
  console.log(`LP PDA (idx=0):  ${lpPda.toBase58()}`);
  console.log(`Vault ATA:       ${vaultAta.toBase58()}`);
  console.log();
  console.log("Transactions:");
  console.log(`  TX1 InitMarket:    ${sig1}`);
  console.log(`  TX2 SetDexPool:    ${sig2}`);
  console.log(`  TX3 InitLP:        ${sig3}`);
  console.log(`  TX4 InitMatcherCtx: ${sig4}`);
  if (sig5) console.log(`  TX5 TopUpInsurance: ${sig5}`);
  if (sig6) console.log(`  TX6 TopUpKeeperFund: ${sig6}`);
  if (sig7) console.log(`  TX7 SetOracleAuthority: ${sig7}`);
  console.log();
  console.log(`Config saved to: ${outFile}`);
  console.log();
  console.log("NEXT STEPS:");
  console.log("  1. Insert market row into Supabase (see SQL above in script)");
  console.log("  2. Restart keeper + indexer to discover the new market");
  console.log("  3. Wait for first crank (~30s) before attempting trades");
  console.log();
  console.log("Addresses:");
  console.log(
    JSON.stringify(
      {
        programId: cfg.programId.toBase58(),
        slabAddress: slab.publicKey.toBase58(),
        matcherCtxAddress: matcherCtx.publicKey.toBase58(),
        keeperFundPda: keeperFundPda.toBase58(),
        lpPda: lpPda.toBase58(),
        vaultAta: vaultAta.toBase58(),
        collateralMint: cfg.collateralMint.toBase58(),
        dexPool: cfg.dexPoolAddress.toBase58(),
        network: cfg.network,
      },
      null,
      2,
    ),
  );
  console.log("=================================================");
}

main().catch((e) => {
  console.error("Fatal error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
