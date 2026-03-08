/**
 * PERC-408: Full slab reinit — close broken slab + recreate + InitMarket.
 *
 * This script:
 * 1. Reads all market config from the broken slab (header, config, params, mark price)
 * 2. If no active accounts (or --force), closes the slab via CloseSlab instruction
 * 3. Creates a new slab account with the correct SLAB_TIERS size (new keypair)
 * 4. Calls InitMarket to fully re-initialize the market on the new slab
 *
 * ⚠️ DEVNET ONLY — closing a slab with active positions loses user funds.
 *
 * Usage:
 *   npx tsx scripts/reinit-slab.ts --slab <SLAB_PUBKEY> [--force] [--dry-run] [--tier small|medium|large]
 *
 * Requirements:
 *   - .env with RPC_URL and ADMIN_KEYPAIR_PATH
 *   - Sufficient SOL in admin wallet (small ~0.45, medium ~1.8, large ~7.14)
 *   - Admin must be the slab's admin (as stored in slab header)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

import { SLAB_TIERS } from "../packages/core/src/solana/discovery.js";
import {
  parseHeader,
  parseConfig,
  parseParams,
  parseEngine,
  parseAllAccounts,
} from "../packages/core/src/solana/slab.js";
import {
  encodeCloseSlab,
  encodeInitMarket,
} from "../packages/core/src/abi/instructions.js";
import {
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_INIT_MARKET,
  buildAccountMetas,
} from "../packages/core/src/abi/accounts.js";
import { deriveVaultAuthority } from "../packages/core/src/solana/pda.js";
import { buildIx } from "../packages/core/src/runtime/tx.js";

dotenv.config();

// ============================================================================
// CLI ARGS
// ============================================================================

const { values: args } = parseArgs({
  options: {
    slab: { type: "string" },
    force: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    tier: { type: "string" },  // optional override; auto-detected from size if omitted
  },
  strict: true,
});

if (!args.slab) throw new Error("--slab <PUBKEY> is required");

const DRY_RUN = args["dry-run"] ?? false;
const FORCE = args["force"] ?? false;

// ENGINE_OFF is imported from packages/core/src/solana/slab.ts — single source of truth.
// Do NOT hardcode ENGINE_OFF or ENGINE_MARK_PRICE_OFF here; use parseEngine() instead.

// ============================================================================
// HELPERS
// ============================================================================

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~/")
    ? path.replace("~", process.env.HOME || "")
    : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
}

/**
 * Determine which SLAB_TIERS key best matches a given data size.
 * Checks current tier sizes first, then V1 legacy sizes (which map to the same
 * tier key — e.g. V1 small → reinit as current small).
 * Returns null if no match found.
 */
function detectTierFromSize(dataSize: number): keyof typeof SLAB_TIERS | null {
  // Exact match against current (v0/v2) tier sizes
  for (const [key, tier] of Object.entries(SLAB_TIERS)) {
    if (tier.dataSize === dataSize) return key as keyof typeof SLAB_TIERS;
  }
  // V1 legacy sizes — map each V1 size to its equivalent current tier key
  // V1: small=65_352, medium=257_448, large=1_025_832
  const V1_SIZE_TO_TIER: Record<number, keyof typeof SLAB_TIERS> = {
    65_352:    "small",
    257_448:   "medium",
    1_025_832: "large",
  };
  if (V1_SIZE_TO_TIER[dataSize] !== undefined) {
    console.log(`  Note: V1 legacy size detected (${dataSize} bytes → ${V1_SIZE_TO_TIER[dataSize]} tier). Will reinit to current size.`);
    return V1_SIZE_TO_TIER[dataSize];
  }
  // Return null — caller will fall back to --tier flag or heuristic
  return null;
}

/**
 * For undersized slabs: infer intended tier from how close the size is.
 * small tier range: < 100KB, medium: 100KB–500KB, large: 500KB+
 */
function heuristicTier(dataSize: number): keyof typeof SLAB_TIERS {
  if (dataSize < 100_000) return "small";
  if (dataSize < 500_000) return "medium";
  return "large";
}

const PRIORITY_FEE = 50_000;

/**
 * Devnet program IDs → slab tier.
 * Allows auto-detecting the intended tier from the program owner even when
 * the slab has a wrong/legacy size (which breaks size-based detection).
 *
 * Source of truth: app/scripts/deploy-all-tiers.ts
 *   Small  (256 slots,  62_808 bytes): FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD
 *   Medium (1024 slots, 248_760 bytes): FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn
 *   Large  (4096 slots, 992_568 bytes): g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in
 */
const PROGRAM_TO_TIER: Record<string, keyof typeof SLAB_TIERS> = {
  "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD": "small",   // 256 slots  (~0.44 SOL)
  "FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn": "medium",  // 1024 slots (~1.73 SOL)
  "g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in":  "large",   // 4096 slots (~6.90 SOL)
};

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("PERC-408: FULL SLAB REINIT (close + create + InitMarket)");
  console.log("=".repeat(70));

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL not set in .env");

  // Guard: DEVNET ONLY — abort before any destructive action if not devnet/localhost
  const rpcLower = rpcUrl.toLowerCase();
  if (
    !rpcLower.includes("devnet") &&
    !rpcLower.includes("localhost") &&
    !rpcLower.includes("127.0.0.1")
  ) {
    throw new Error(
      `reinit-slab: refusing to run on non-devnet cluster.\n` +
      `  RPC_URL = ${rpcUrl}\n` +
      `  This script closes and recreates slab accounts — DEVNET ONLY.\n` +
      `  Use RPC_URL pointing at devnet (e.g. https://api.devnet.solana.com).`,
    );
  }

  const keypairPath = process.env.ADMIN_KEYPAIR_PATH || "./admin-keypair.json";
  const payer = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  const slabPubkey = new PublicKey(args.slab!);

  console.log(`\nAdmin:    ${payer.publicKey.toBase58()}`);
  console.log(`Slab:     ${slabPubkey.toBase58()}`);
  console.log(`Dry run:  ${DRY_RUN ? "YES" : "no"}`);
  console.log(`Force:    ${FORCE ? "YES (will close even with active accounts)" : "no"}`);

  // ========================================================================
  // Step 1: Fetch and diagnose the broken slab
  // ========================================================================
  console.log("\n--- Step 1: Diagnose broken slab ---");

  const accountInfo = await connection.getAccountInfo(slabPubkey);
  if (!accountInfo) {
    throw new Error(`Slab account not found on-chain: ${slabPubkey.toBase58()}`);
  }

  const PROGRAM_ID = accountInfo.owner;
  const dataSize = accountInfo.data.length;
  const data = new Uint8Array(accountInfo.data);

  console.log(`  Owner program: ${PROGRAM_ID.toBase58()}`);
  console.log(`  On-chain size: ${dataSize} bytes`);

  // Detect tier: --tier flag > owner program ID > exact current-size match > heuristic
  //
  // Priority rationale:
  //  1. --tier flag is explicit — always wins.
  //  2. Program owner is the most reliable source: the program's compiled SLAB_LEN
  //     determines what slab size is ACCEPTED. A 65352-byte V1-small slab under
  //     FwfBKZXb... (medium program) must be reinitialised as medium (248760 bytes).
  //     Size-based detection would wrongly pick "small" for V1 legacy slabs, which
  //     still won't match the medium program binary.
  //  3. Exact size match (current SLAB_TIERS) — only used if program not in the map.
  //  4. Heuristic — last resort.
  const detectedTier = detectTierFromSize(dataSize);
  const argTier = args.tier as keyof typeof SLAB_TIERS | undefined;
  const programTier = PROGRAM_TO_TIER[PROGRAM_ID.toBase58()];

  let targetTier: keyof typeof SLAB_TIERS;
  if (argTier && !SLAB_TIERS[argTier]) {
    // Unknown --tier value: fail fast rather than silently auto-detecting
    console.error(`\n❌ Unknown --tier value: "${argTier}"`);
    console.error(`   Allowed values: ${Object.keys(SLAB_TIERS).join(", ")}`);
    process.exit(1);
  } else if (argTier && SLAB_TIERS[argTier]) {
    targetTier = argTier;
    console.log(`  Tier:          ${targetTier} (from --tier flag)`);
  } else if (programTier) {
    targetTier = programTier;
    console.log(`  Tier:          ${targetTier} (from owner program — authoritative)`);
    if (detectedTier && detectedTier !== programTier) {
      console.log(`  Note: size-based detection suggested "${detectedTier}" but program-based is preferred.`);
      console.log(`        Use --tier ${detectedTier} to override if you know the program was recompiled.`);
    }
  } else if (detectedTier) {
    targetTier = detectedTier;
    console.log(`  Tier:          ${targetTier} (exact size match — program not in known-program map)`);
  } else {
    targetTier = heuristicTier(dataSize);
    console.log(`  Tier:          ${targetTier} (heuristic fallback — unknown program owner)`);
  }

  const tier = SLAB_TIERS[targetTier];
  const isCorrectSize = dataSize === tier.dataSize;

  if (isCorrectSize) {
    console.log(`\n✅ Slab already has correct size for ${targetTier} tier (${tier.dataSize} bytes). No reinit needed.`);
    return;
  }

  console.log(`  Expected size: ${tier.dataSize} bytes (${tier.label} tier, ${tier.maxAccounts} accounts)`);
  console.log(`  Size delta:    ${tier.dataSize - dataSize > 0 ? "+" : ""}${tier.dataSize - dataSize} bytes`);

  // ========================================================================
  // Step 2: Read ALL market config from the broken slab BEFORE closing
  // ========================================================================
  console.log("\n--- Step 2: Extract market config from broken slab ---");

  let header;
  try {
    header = parseHeader(data);
    console.log(`  Admin (slab):  ${header.admin.toBase58()}`);
    console.log(`  Version:       ${header.version}`);
    console.log(`  Flags:         ${header.flags} (resolved=${header.resolved}, paused=${header.paused})`);
  } catch (e) {
    throw new Error(`Failed to parse slab header: ${e}. Cannot safely reinit.`);
  }

  let config;
  try {
    config = parseConfig(data);
    console.log(`  Collateral:    ${config.collateralMint.toBase58()}`);
    console.log(`  Vault:         ${config.vaultPubkey.toBase58()}`);
    console.log(`  Oracle feed:   ${config.indexFeedId.toBase58()}`);
    console.log(`  Staleness:     ${config.maxStalenessSlots} slots`);
    console.log(`  Invert:        ${config.invert}`);
    console.log(`  Unit scale:    ${config.unitScale}`);
  } catch (e) {
    throw new Error(`Failed to parse slab config: ${e}. Cannot safely reinit.`);
  }

  let params;
  try {
    params = parseParams(data);
    console.log(`  Maint margin:  ${params.maintenanceMarginBps} bps`);
    console.log(`  Init margin:   ${params.initialMarginBps} bps`);
    console.log(`  Trading fee:   ${params.tradingFeeBps} bps`);
    console.log(`  Max accounts:  ${params.maxAccounts}`);
  } catch (e) {
    throw new Error(`Failed to parse slab params: ${e}. Cannot safely reinit.`);
  }

  // Read mark price via parseEngine — uses the canonical offset from slab.ts.
  // This prevents silent drift if ENGINE_OFF or ENGINE_MARK_PRICE_OFF changes.
  const engine = parseEngine(data);
  const markPriceE6 = engine.markPriceE6;
  // If the slab was never cranked, mark price may be 0; use a safe fallback
  const initialMarkPrice = markPriceE6 > 0n ? markPriceE6 : 1_000_000n;
  console.log(`  Mark price:    ${markPriceE6} (using: ${initialMarkPrice})`);

  // Check active accounts
  let activeAccounts = 0;
  try {
    const accounts = parseAllAccounts(data);
    activeAccounts = accounts.length;
  } catch {
    console.log(`  ⚠️  Could not parse accounts array (expected for broken size)`);
  }
  // ⚠️ On undersized slabs the accounts array offset is wrong, so the count
  // is unreliable (may be garbage). Treat non-zero counts as advisory only.
  if (dataSize !== tier.dataSize && activeAccounts > 0) {
    console.log(`  Active accts:  ${activeAccounts} (⚠️  MAY BE UNRELIABLE — slab has wrong size, layout offsets are off)`);
  } else {
    console.log(`  Active accts:  ${activeAccounts}`);
  }

  if (activeAccounts > 0 && !FORCE) {
    const unreliable = dataSize !== tier.dataSize;
    console.error(`\n❌ Slab reports ${activeAccounts} active accounts.`);
    if (unreliable) {
      console.error("   NOTE: This count is likely unreliable due to the broken slab size.");
      console.error("   On a properly-sized slab with 0x4 errors this is usually 0.");
    }
    console.error("   Pass --force to proceed (DEVNET ONLY — will lose user positions).");
    if (!DRY_RUN) process.exit(1);
  }

  // Confirm the admin keypair matches the slab admin
  const adminMismatch = header.admin.toBase58() !== payer.publicKey.toBase58();
  if (adminMismatch) {
    console.error(`\n❌ Admin keypair mismatch.`);
    console.error(`   Slab admin: ${header.admin.toBase58()}`);
    console.error(`   Your key:   ${payer.publicKey.toBase58()}`);
    console.error("   Use ADMIN_KEYPAIR_PATH env var to point to the correct keypair.");
    if (!DRY_RUN) process.exit(1);
    console.error("   (dry-run: showing plan anyway)");
  }

  if (DRY_RUN) {
    console.log("\n🔍 DRY RUN — would execute the following:");
    console.log("  0. Generate new slab keypair and save to ./new-slab-keypair-<timestamp>.json");
    console.log("  1. CloseSlab on", slabPubkey.toBase58());
    console.log("  2. SystemProgram.createAccount (new keypair, size =", tier.dataSize, "bytes)");
    console.log("  3. InitMarket with extracted config");
    console.log("\n  ⚠️  New slab will have a DIFFERENT address from the old one.");
    console.log("     Update keeper/trader-fleet config with the new slab address after reinit.");
    return;
  }

  // ========================================================================
  // Step 3: Close the broken slab
  // ========================================================================
  console.log("\n--- Step 3: Close broken slab ---");

  const closeTx = new Transaction();
  closeTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  closeTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  closeTx.add(
    buildIx({
      programId: PROGRAM_ID,
      data: encodeCloseSlab(),
      keys: buildAccountMetas(ACCOUNTS_CLOSE_SLAB, [
        payer.publicKey,   // admin
        slabPubkey,        // slab
      ]),
    }),
  );

  const closeSig = await sendAndConfirmTransaction(connection, closeTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ CloseSlab confirmed: ${closeSig}`);
  console.log(`     Explorer: https://explorer.solana.com/tx/${closeSig}?cluster=devnet`);

  // ========================================================================
  // Step 4: Create new slab account with correct size
  // ========================================================================
  console.log("\n--- Step 4: Create new slab account ---");

  const newSlabKp = Keypair.generate();

  // CRITICAL: Persist new slab keypair to disk BEFORE any transactions.
  // If the process dies after CloseSlab but before InitMarket completes,
  // this file lets you recover the pubkey and retry InitMarket manually.
  const newSlabKpPath = `./new-slab-keypair-${Date.now()}.json`;
  fs.writeFileSync(
    newSlabKpPath,
    JSON.stringify(Array.from(newSlabKp.secretKey)),
    "utf-8",
  );
  console.log(`  ✅ New slab keypair saved: ${newSlabKpPath}`);
  console.log(`     Pubkey: ${newSlabKp.publicKey.toBase58()}`);
  console.log(`     ⚠️  Keep this file safe — needed to recover if the script fails mid-flight.`);

  const slabRent = await connection.getMinimumBalanceForRentExemption(tier.dataSize);

  console.log(`  Tier:      ${tier.label} (${tier.dataSize} bytes, ${tier.maxAccounts} accounts)`);
  console.log(`  Rent:      ${(slabRent / 1e9).toFixed(4)} SOL`);

  const adminBalance = await connection.getBalance(payer.publicKey);
  const needed = slabRent + 50_000_000; // + ~0.05 SOL buffer for txs
  if (adminBalance < needed) {
    throw new Error(
      `Insufficient SOL: have ${(adminBalance / 1e9).toFixed(4)}, need ${(needed / 1e9).toFixed(4)} ` +
      `(${(slabRent / 1e9).toFixed(4)} rent + 0.05 tx buffer)`
    );
  }

  const createTx = new Transaction();
  createTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }));
  createTx.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: newSlabKp.publicKey,
      lamports: slabRent,
      space: tier.dataSize,
      programId: PROGRAM_ID,
    }),
  );

  const createSig = await sendAndConfirmTransaction(connection, createTx, [payer, newSlabKp], {
    commitment: "confirmed",
  });
  console.log(`  ✅ New slab created: ${createSig}`);

  // ========================================================================
  // Step 5: Create vault ATA for new slab, then call InitMarket
  // ========================================================================
  console.log("\n--- Step 5: Create vault ATA + InitMarket ---");

  const mint = config.collateralMint;

  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, newSlabKp.publicKey);
  const vaultAccount = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint, vaultPda, true,
  );
  const vault = vaultAccount.address;
  console.log(`  Vault PDA:     ${vaultPda.toBase58()}`);
  console.log(`  Vault ATA:     ${vault.toBase58()}`);

  // Build the oracle feed ID hex string from the stored PublicKey bytes
  // indexFeedId is stored as 32 raw bytes; convert to 64-char hex for encodeInitMarket
  const feedIdHex = Buffer.from(config.indexFeedId.toBytes()).toString("hex");
  const isAdminOracle = feedIdHex === "0".repeat(64);
  console.log(`  Oracle mode:   ${isAdminOracle ? "Admin oracle (permissioned push)" : "Pyth Pull"}`);
  if (!isAdminOracle) {
    console.log(`  Feed ID:       ${feedIdHex}`);
  }

  const initMarketData = encodeInitMarket({
    admin:                  payer.publicKey,
    collateralMint:         mint,
    indexFeedId:            feedIdHex,
    maxStalenessSecs:       config.maxStalenessSlots,  // oracle staleness from parsed config
    confFilterBps:          config.confFilterBps,
    invert:                 config.invert,
    unitScale:              config.unitScale,
    initialMarkPriceE6:     initialMarkPrice.toString(),
    warmupPeriodSlots:      params.warmupPeriodSlots.toString(),
    maintenanceMarginBps:   params.maintenanceMarginBps.toString(),
    initialMarginBps:       params.initialMarginBps.toString(),
    tradingFeeBps:          params.tradingFeeBps.toString(),
    maxAccounts:            BigInt(tier.maxAccounts).toString(),
    newAccountFee:          params.newAccountFee.toString(),
    riskReductionThreshold: params.riskReductionThreshold.toString(),
    maintenanceFeePerSlot:  params.maintenanceFeePerSlot.toString(),
    maxCrankStalenessSlots: params.maxCrankStalenessSlots.toString(),
    liquidationFeeBps:      params.liquidationFeeBps.toString(),
    liquidationFeeCap:      params.liquidationFeeCap.toString(),
    liquidationBufferBps:   params.liquidationBufferBps.toString(),
    minLiquidationAbs:      params.minLiquidationAbs.toString(),
  });

  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    payer.publicKey,        // admin
    newSlabKp.publicKey,    // slab
    mint,                   // mint
    vault,                  // vault
    TOKEN_PROGRAM_ID,       // tokenProgram
    SYSVAR_CLOCK_PUBKEY,    // clock
    SYSVAR_RENT_PUBKEY,     // rent
    vault,                  // dummyAta (same vault ATA)
    SystemProgram.programId, // systemProgram
  ]);

  const initTx = new Transaction();
  initTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE }));
  initTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  initTx.add(buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData }));

  const initSig = await sendAndConfirmTransaction(connection, initTx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ✅ InitMarket confirmed: ${initSig}`);
  console.log(`     Explorer: https://explorer.solana.com/tx/${initSig}?cluster=devnet`);

  // ========================================================================
  // DONE — print summary
  // ========================================================================
  console.log("\n" + "=".repeat(70));
  console.log("✅ REINIT COMPLETE");
  console.log("=".repeat(70));
  console.log(`\nOLD slab (closed):  ${slabPubkey.toBase58()}`);
  console.log(`NEW slab (active):  ${newSlabKp.publicKey.toBase58()}`);
  console.log(`Program:            ${PROGRAM_ID.toBase58()}`);
  console.log(`Tier:               ${tier.label} (${tier.dataSize} bytes)`);
  console.log(`\n⚠️  NEXT STEPS:`);
  console.log(`  1. Secure new slab keypair file: ${newSlabKpPath}`);
  console.log(`     → New slab pubkey: ${newSlabKp.publicKey.toBase58()}`);
  console.log(`  2. Run InitLP on the new slab to enable LP deposits:`);
  console.log(`     npx tsx scripts/create-market.ts --existing-slab ${newSlabKp.publicKey.toBase58()} --step init-lp ...`);
  console.log(`  3. Update keeper/trader-fleet config with new slab address`);
  console.log(`  4. Message devops to update Railway env vars`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nFatal:", err.message ?? err);
  process.exit(1);
});
