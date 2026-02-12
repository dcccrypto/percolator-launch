/**
 * End-to-end devnet test: create market → init user → deposit → trade
 * Run: npx tsx tests/devnet-e2e.ts
 */
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import {
  encodeInitMarket,
  encodeSetOracleAuthority,
  encodePushOraclePrice,
  encodeKeeperCrank,
  encodeInitVamm,
  encodeInitLP,
  encodeDepositCollateral,
  encodeInitUser,
  encodeTradeCpi,
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_INIT_VAMM,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_TRADE_CPI,
  buildAccountMetas,
  buildIx,
  getAta,
  deriveVaultAuthority,
  deriveLpPda,
  WELL_KNOWN,
  SLAB_TIERS,
  parseConfig,
  parseEngine,
  parseAllAccounts,
} from "../packages/core/src/index.js";
import * as fs from "fs";

// Config
const RPC_URL = `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ""}`;
// Use centralized config instead of hard-coded ID
import { getProgramId } from "../packages/core/src/config/program-ids.js";
const PROGRAM_ID = getProgramId("devnet");
const MATCHER_ID = new PublicKey("4HcGCsyjAqnFua5ccuXyt8KRRQzKFbGTJkVChpS7Yfzy");
const CRANK_WALLET = new PublicKey("2JaSzRYrf44fPpQBtRJfnCEgThwCmvpFd3FCXi45VXxm");
const MINT = new PublicKey("DvH13uxzTzo1xVFwkbJ6YASkZWs6bm3vFDH4xu7kUYTs");
const DEPLOYER_KP = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/tmp/deployer.json", "utf8"))));

const connection = new Connection(RPC_URL, "confirmed");

async function sendTx(ixs: any[], signers: Keypair[], computeUnits = 400_000) {
  const { ComputeBudgetProgram, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of ixs) tx.add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
  return sig;
}

async function main() {
  console.log("=== Devnet E2E Test ===");
  console.log(`Deployer: ${DEPLOYER_KP.publicKey.toBase58()}`);
  console.log(`Mint: ${MINT.toBase58()}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(DEPLOYER_KP.publicKey);
  console.log(`SOL balance: ${balance / 1e9}`);

  const tier = SLAB_TIERS.small;
  console.log(`\nUsing tier: small (${tier.maxAccounts} slots, ${tier.dataSize} bytes)`);

  // Step 0: Create slab account
  console.log("\n--- Step 0: Create Slab ---");
  const { SystemProgram } = await import("@solana/web3.js");
  const slabKeypair = Keypair.generate();
  const rent = await connection.getMinimumBalanceForRentExemption(tier.dataSize);
  console.log(`Slab rent: ${rent / 1e9} SOL`);

  const createSlabIx = SystemProgram.createAccount({
    fromPubkey: DEPLOYER_KP.publicKey,
    newAccountPubkey: slabKeypair.publicKey,
    lamports: rent,
    space: tier.dataSize,
    programId: PROGRAM_ID,
  });

  // Step 1: Init market + vault
  console.log("--- Step 1: Init Market ---");
  const [vaultPda] = deriveVaultAuthority(PROGRAM_ID, slabKeypair.publicKey);
  const vaultAta = await getAta(vaultPda, MINT);

  // Create vault ATA
  const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
  const createVaultAtaIx = createAssociatedTokenAccountInstruction(
    DEPLOYER_KP.publicKey, vaultAta, vaultPda, MINT
  );

  const initMarketData = encodeInitMarket({
    admin: DEPLOYER_KP.publicKey,
    collateralMint: MINT,
    indexFeedId: "0".repeat(64),              // All zeros = Hyperp mode (admin oracle)
    maxStalenessSecs: "86400",
    confFilterBps: 0,
    invert: 0,                                 // 0 = no inversion
    unitScale: 0,                              // 0 = no scaling
    initialMarkPriceE6: "1000000",             // 1.0 initial price (E6)
    warmupPeriodSlots: "100",                  // 100 slots warmup
    maintenanceMarginBps: "100",               // 1% maintenance margin
    initialMarginBps: "500",                   // 5% initial margin
    tradingFeeBps: "30",                       // 0.3% trading fee
    maxAccounts: tier.maxAccounts,
    newAccountFee: "1000000",                  // 1 token account creation fee
    riskReductionThreshold: "800",             // 8% risk reduction threshold
  });
  const initMarketKeys = buildAccountMetas(ACCOUNTS_INIT_MARKET, [
    DEPLOYER_KP.publicKey, slabKeypair.publicKey,
  ]);
  const initMarketIx = buildIx({ programId: PROGRAM_ID, keys: initMarketKeys, data: initMarketData });

  let sig = await sendTx([createSlabIx, createVaultAtaIx, initMarketIx], [DEPLOYER_KP, slabKeypair]);
  console.log(`✅ Step 0+1 OK: ${sig}`);
  console.log(`Slab: ${slabKeypair.publicKey.toBase58()}`);

  // Step 2: Oracle setup
  console.log("\n--- Step 2: Oracle Setup ---");
  const setAuthData = encodeSetOracleAuthority({ newAuthority: DEPLOYER_KP.publicKey });
  const setAuthKeys = buildAccountMetas(ACCOUNTS_SET_ORACLE_AUTHORITY, [DEPLOYER_KP.publicKey, slabKeypair.publicKey]);
  const setAuthIx = buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthData });

  const pushData = encodePushOraclePrice({ priceE6: 1_000_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  const pushKeys = buildAccountMetas(ACCOUNTS_PUSH_ORACLE_PRICE, [DEPLOYER_KP.publicKey, slabKeypair.publicKey]);
  const pushIx = buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData });

  const crankData = encodeKeeperCrank({ callerIdx: 65535, allowPanic: false });
  const crankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [DEPLOYER_KP.publicKey, slabKeypair.publicKey, SYSVAR_CLOCK_PUBKEY, slabKeypair.publicKey]);
  const crankIx = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

  sig = await sendTx([setAuthIx, pushIx, crankIx], [DEPLOYER_KP]);
  console.log(`✅ Step 2 OK: ${sig}`);

  // Step 3: Init LP (vAMM matcher)
  console.log("\n--- Step 3: Init LP ---");
  const matcherCtxKeypair = Keypair.generate();
  const matcherCtxRent = await connection.getMinimumBalanceForRentExemption(320);
  const createMatcherIx = SystemProgram.createAccount({
    fromPubkey: DEPLOYER_KP.publicKey,
    newAccountPubkey: matcherCtxKeypair.publicKey,
    lamports: matcherCtxRent,
    space: 320,
    programId: MATCHER_ID,
  });

  const initVammData = encodeInitVamm({});
  const initVammKeys = buildAccountMetas(ACCOUNTS_INIT_VAMM, [
    DEPLOYER_KP.publicKey, matcherCtxKeypair.publicKey,
  ]);
  const initVammIx = buildIx({ programId: MATCHER_ID, keys: initVammKeys, data: initVammData });

  const userAta = await getAta(DEPLOYER_KP.publicKey, MINT);
  const initLpData = encodeInitLP({ feePayment: "1000000" });
  const [lpPda] = deriveLpPda(PROGRAM_ID, slabKeypair.publicKey, 0);
  const initLpKeys = buildAccountMetas(ACCOUNTS_INIT_LP, [
    DEPLOYER_KP.publicKey, slabKeypair.publicKey, userAta, vaultAta,
    WELL_KNOWN.tokenProgram, MATCHER_ID, matcherCtxKeypair.publicKey, lpPda,
  ]);
  const initLpIx = buildIx({ programId: PROGRAM_ID, keys: initLpKeys, data: initLpData });

  sig = await sendTx([createMatcherIx, initVammIx, initLpIx], [DEPLOYER_KP, matcherCtxKeypair]);
  console.log(`✅ Step 3 OK: ${sig}`);

  // Step 4: Deposit + Insurance + Delegate to crank
  console.log("\n--- Step 4: Deposit + Finalize ---");
  const depositData = encodeDepositCollateral({ userIdx: 0, amount: "1000000000" }); // 1000 tokens
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, [
    DEPLOYER_KP.publicKey, slabKeypair.publicKey, userAta, vaultAta, WELL_KNOWN.tokenProgram, WELL_KNOWN.clock,
  ]);
  const depositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: depositData });

  // Insurance deposit (same as deposit but to insurance fund idx)
  const insData = encodeDepositCollateral({ userIdx: 0, amount: "100000000" }); // 100 tokens insurance
  const insIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: insData });

  // Fresh push + crank
  const pushData2 = encodePushOraclePrice({ priceE6: 1_000_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  const pushIx2 = buildIx({ programId: PROGRAM_ID, keys: pushKeys, data: pushData2 });
  const crankIx2 = buildIx({ programId: PROGRAM_ID, keys: crankKeys, data: crankData });

  // Delegate to crank wallet LAST
  const setAuthCrankData = encodeSetOracleAuthority({ newAuthority: CRANK_WALLET });
  const setAuthCrankIx = buildIx({ programId: PROGRAM_ID, keys: setAuthKeys, data: setAuthCrankData });

  sig = await sendTx([depositIx, pushIx2, crankIx2, setAuthCrankIx], [DEPLOYER_KP]);
  console.log(`✅ Step 4 OK: ${sig}`);

  // Step 5: Init User account
  console.log("\n--- Step 5: Init User ---");
  const initUserData = encodeInitUser({ feePayment: "1000000" });
  const initUserKeys = buildAccountMetas(ACCOUNTS_INIT_USER, [
    DEPLOYER_KP.publicKey, slabKeypair.publicKey, userAta, vaultAta, WELL_KNOWN.tokenProgram,
  ]);
  const initUserIx = buildIx({ programId: PROGRAM_ID, keys: initUserKeys, data: initUserData });

  sig = await sendTx([initUserIx], [DEPLOYER_KP]);
  console.log(`✅ Step 5 (Init User) OK: ${sig}`);

  // Step 6: Deposit collateral to user account  
  console.log("\n--- Step 6: Deposit to User ---");
  // Need to find user's account index
  const slabInfo = await connection.getAccountInfo(slabKeypair.publicKey);
  if (!slabInfo) throw new Error("Slab not found");
  const accounts = parseAllAccounts(new Uint8Array(slabInfo.data));
  console.log(`Found ${accounts.length} accounts on slab`);
  
  const userAccount = accounts.find(a => a.account.owner.equals(DEPLOYER_KP.publicKey) && a.account.kind === 1);
  if (!userAccount) throw new Error("User account not found");
  console.log(`User account idx: ${userAccount.idx}`);

  const userDepositData = encodeDepositCollateral({ userIdx: userAccount.idx, amount: "10000000" }); // 10 tokens
  const userDepositIx = buildIx({ programId: PROGRAM_ID, keys: depositKeys, data: userDepositData });

  sig = await sendTx([userDepositIx], [DEPLOYER_KP]);
  console.log(`✅ Step 6 (Deposit) OK: ${sig}`);

  // Step 7: Trade!
  console.log("\n--- Step 7: TRADE ---");
  const lpAccount = accounts.find(a => a.account.kind === 0); // LP
  if (!lpAccount) throw new Error("LP account not found");
  console.log(`LP account idx: ${lpAccount.idx}`);

  // Prepend push + crank (we need fresh oracle since we delegated to crank but crank may not have pushed yet)
  // Actually crank wallet is the authority now, so WE can't push. The crank service should handle it.
  // Just do a permissionless crank then trade
  const tradecrankKeys = buildAccountMetas(ACCOUNTS_KEEPER_CRANK, [
    DEPLOYER_KP.publicKey, slabKeypair.publicKey, SYSVAR_CLOCK_PUBKEY, slabKeypair.publicKey,
  ]);
  const tradeCrankIx = buildIx({ programId: PROGRAM_ID, keys: tradecrankKeys, data: crankData });

  const [tradeLpPda] = deriveLpPda(PROGRAM_ID, slabKeypair.publicKey, lpAccount.idx);
  const tradeData = encodeTradeCpi({
    lpIdx: lpAccount.idx,
    userIdx: userAccount.idx,
    size: "1000000", // 1 token long
  });
  const tradeKeys = buildAccountMetas(ACCOUNTS_TRADE_CPI, [
    DEPLOYER_KP.publicKey,
    lpAccount.account.owner,
    slabKeypair.publicKey,
    WELL_KNOWN.clock,
    slabKeypair.publicKey, // oracle = slab for admin oracle
    lpAccount.account.matcherProgram,
    lpAccount.account.matcherContext,
    tradeLpPda,
  ]);
  const tradeIx = buildIx({ programId: PROGRAM_ID, keys: tradeKeys, data: tradeData });

  sig = await sendTx([tradeCrankIx, tradeIx], [DEPLOYER_KP], 600_000);
  console.log(`✅ Step 7 (TRADE) OK: ${sig}`);

  console.log("\n=== ALL TESTS PASSED ===");
  console.log(`Market: ${slabKeypair.publicKey.toBase58()}`);
  console.log(`Trade page: https://percolatorlaunch.com/trade/${slabKeypair.publicKey.toBase58()}`);
}

main().catch(err => {
  console.error("❌ FAILED:", err);
  process.exit(1);
});
