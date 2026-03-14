/**
 * Multi-tier InitMarket + Oracle smoke test (PERC-337 / PERC-338)
 * Creates a fresh SPL test-mint (QA as authority) per run to avoid mint-auth issues.
 * Tests Small + Medium tiers; skips Large if insufficient SOL (needs 7.14 SOL).
 * Run: HELIUS_DEVNET_API_KEY=... npx tsx tests/smoke-all-tiers.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram,
  SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  mintTo,
  createAccount,
} from "@solana/spl-token";
import {
  encodeInitMarket,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeKeeperCrank,
  SLAB_TIERS,
  deriveVaultAuthority,
} from "../packages/core/src/index.js";
import * as fs from "fs";

const RPC_URL = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_DEVNET_API_KEY ?? process.env.HELIUS_API_KEY ?? ""}`;
const DEPLOYER_KP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/deployer.json", "utf8"))));

// Actual deployed SLAB_LEN values from commit 27acb05 (SLAB_TIERS.*.dataSize + 40 bytes from _reserved field).
// Small  program expects: 0xff48 = 65352, SLAB_TIERS says 65312 — off by 40
// Medium program expects: 0x3eda8 = 257448, SLAB_TIERS says 257408 — off by 40
// Large  program expected: ~1025832 (estimated same delta)
const TIERS = [
  { name: "Small",  programId: new PublicKey("FwfBKZXbYr4vTK23bMFkbgKq3npJ3MSDxEaKmq9Aj4Qn"), slabSize: 65352,   maxAccounts: 256,  solNeeded: 0.70 },
  { name: "Medium", programId: new PublicKey("g9msRSV3sJmmE3r5Twn9HuBsxzuuRGTjKCVTKudm9in"),  slabSize: 257448,  maxAccounts: 1024, solNeeded: 2.00 },
  { name: "Large",  programId: new PublicKey("FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD"), slabSize: 1025832, maxAccounts: 4096, solNeeded: 7.30 },
];

const MIN_VAULT_SEED = 500_000_000n; // 500 tokens at 6 decimals (MIN_INIT_MARKET_SEED_LAMPORTS)
const connection = new Connection(RPC_URL, "confirmed");

async function sendTx(ixs: TransactionInstruction[], signers: Keypair[], computeUnits = 800_000) {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of ixs) tx.add(ix);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

function buildIx(programId: PublicKey, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Uint8Array) {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

async function smokeInitMarket(tierName: string, programId: PublicKey, slabSize: number, maxAccounts: number, mint: PublicKey) {
  console.log(`\n=== ${tierName} Tier (${programId.toBase58().slice(0,8)}...) ===`);

  const slabKp = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(slabSize);
  console.log(`  Slab rent: ${(rent / 1e9).toFixed(4)} SOL  (slabSize=${slabSize.toLocaleString()})`);

  // Derive vault PDA and its ATA
  const [vaultPda] = deriveVaultAuthority(programId, slabKp.publicKey);
  const vaultAta = await getAssociatedTokenAddress(mint, vaultPda, true);

  // 1) Create slab account
  const createSlabIx = SystemProgram.createAccount({
    fromPubkey: DEPLOYER_KP.publicKey,
    newAccountPubkey: slabKp.publicKey,
    lamports: rent,
    space: slabSize,
    programId,
  });

  // 2) Create vault ATA
  const createVaultAtaIx = createAssociatedTokenAccountInstruction(
    DEPLOYER_KP.publicKey, vaultAta, vaultPda, mint,
  );

  let sig = await sendTx([createSlabIx, createVaultAtaIx], [DEPLOYER_KP, slabKp]);
  console.log(`  ✅ Slab+VaultATA created: ${sig.slice(0, 24)}...`);

  // 3) Mint seed tokens directly to vault ATA (we own the mint)
  const mintSeedSig = await mintTo(connection, DEPLOYER_KP, mint, vaultAta, DEPLOYER_KP, MIN_VAULT_SEED);
  console.log(`  ✅ Seeded vault with ${Number(MIN_VAULT_SEED) / 1e6} tokens: ${mintSeedSig.slice(0, 24)}...`);

  // 4) InitMarket
  const initMarketData = encodeInitMarket({
    admin: DEPLOYER_KP.publicKey,
    collateralMint: mint,
    indexFeedId: "0".repeat(64),        // all-zeros = Hyperp/admin-oracle mode
    maxStalenessSecs: "86400",
    confFilterBps: 0,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: "1000000",      // $1.00
    warmupPeriodSlots: "100",
    maintenanceMarginBps: "100",        // 1%
    initialMarginBps: "500",            // 5%
    tradingFeeBps: "30",                // 0.3%
    maxAccounts: String(maxAccounts),
    newAccountFee: "1000000",
    riskReductionThreshold: "800",
    maintenanceFeePerSlot: "0",
    maxCrankStalenessSlots: "1000",
    liquidationFeeBps: "100",
    liquidationFeeCap: "10000000000",
    liquidationBufferBps: "50",
    minLiquidationAbs: "1000000",
  });

  // 9-account list: admin, slab, mint, vault, tokenProgram, clock, rent, dummyAta, systemProgram
  const initMarketAccounts = [
    { pubkey: DEPLOYER_KP.publicKey,      isSigner: true,  isWritable: true  }, // admin
    { pubkey: slabKp.publicKey,           isSigner: false, isWritable: true  }, // slab
    { pubkey: mint,                       isSigner: false, isWritable: false }, // mint
    { pubkey: vaultAta,                   isSigner: false, isWritable: false }, // vault
    { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false }, // tokenProgram
    { pubkey: SYSVAR_CLOCK_PUBKEY,        isSigner: false, isWritable: false }, // clock
    { pubkey: SYSVAR_RENT_PUBKEY,         isSigner: false, isWritable: false }, // rent
    { pubkey: vaultAta,                   isSigner: false, isWritable: false }, // dummyAta
    { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false }, // systemProgram
  ];
  const initMarketIx = buildIx(programId, initMarketAccounts, initMarketData);

  const sigIM = await sendTx([initMarketIx], [DEPLOYER_KP]);
  console.log(`  ✅ InitMarket OK: ${sigIM.slice(0, 24)}...`);
  console.log(`     Slab: ${slabKp.publicKey.toBase58()}`);

  // 5) Oracle: set authority + push price + crank
  const setAuthData = encodeSetOracleAuthority({ newAuthority: DEPLOYER_KP.publicKey });
  const setAuthIx = buildIx(programId, [
    { pubkey: DEPLOYER_KP.publicKey, isSigner: true,  isWritable: true },
    { pubkey: slabKp.publicKey,      isSigner: false, isWritable: true },
  ], setAuthData);

  const pushData = encodePushOraclePrice({ priceE6: 1_000_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  const pushIx = buildIx(programId, [
    { pubkey: DEPLOYER_KP.publicKey, isSigner: true,  isWritable: true },
    { pubkey: slabKp.publicKey,      isSigner: false, isWritable: true },
  ], pushData);

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankIx = buildIx(programId, [
    { pubkey: DEPLOYER_KP.publicKey, isSigner: true,  isWritable: true },
    { pubkey: slabKp.publicKey,      isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY,   isSigner: false, isWritable: false },
    { pubkey: slabKp.publicKey,      isSigner: false, isWritable: true },
  ], crankData);

  const sigOracle = await sendTx([setAuthIx, pushIx, crankIx], [DEPLOYER_KP]);
  console.log(`  ✅ Oracle+Crank OK: ${sigOracle.slice(0, 24)}...`);

  return {
    tier: tierName,
    programId: programId.toBase58(),
    slab: slabKp.publicKey.toBase58(),
    status: "PASS",
  };
}

async function main() {
  console.log("=== Percolator Multi-Tier InitMarket Smoke Test ===");
  console.log(`Wallet: ${DEPLOYER_KP.publicKey.toBase58()}`);

  const balance = await connection.getBalance(DEPLOYER_KP.publicKey);
  const solBal = balance / 1e9;
  console.log(`SOL balance: ${solBal.toFixed(4)} SOL`);

  // Create a fresh test mint for this run (QA wallet = mint authority)
  console.log("\n--- Creating test mint (QA as mint authority) ---");
  const mint = await createMint(
    connection, DEPLOYER_KP, DEPLOYER_KP.publicKey, null, 6,
  );
  console.log(`Test mint: ${mint.toBase58()}`);

  const results: any[] = [];
  let remaining = solBal - 0.05; // reserve for mint creation tx

  for (const tier of TIERS) {
    if (remaining < tier.solNeeded) {
      console.log(`\n⚠️  SKIP ${tier.name}: need ${tier.solNeeded} SOL, have ${remaining.toFixed(4)} SOL`);
      results.push({ tier: tier.name, status: "SKIP", reason: `Need ≥${tier.solNeeded} SOL, have ${remaining.toFixed(4)}` });
      continue;
    }
    try {
      const r = await smokeInitMarket(tier.name, tier.programId, tier.slabSize, tier.maxAccounts, mint);
      results.push(r);
      remaining -= tier.solNeeded;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error(`  ❌ ${tier.name} FAILED:`, msg);
      results.push({ tier: tier.name, status: "FAIL", error: msg });
      remaining -= 0.05; // approximate fees
    }
  }

  console.log("\n=== RESULTS SUMMARY ===");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "SKIP" ? "⚠️ " : "❌";
    const extra = r.reason ? ` — ${r.reason}` : r.error ? ` — ${r.error.slice(0, 120)}` : r.slab ? ` — slab ${r.slab.slice(0, 12)}...` : "";
    console.log(`${icon} ${r.tier}: ${r.status}${extra}`);
  }

  const anyFail = results.some(r => r.status === "FAIL");
  process.exit(anyFail ? 1 : 0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
