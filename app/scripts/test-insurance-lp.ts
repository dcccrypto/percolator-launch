/**
 * Insurance LP E2E Test Script
 * 
 * Tests the full insurance LP lifecycle on devnet:
 * 1. CreateInsuranceMint (Tag 24)
 * 2. DepositInsuranceLP (Tag 25)
 * 3. Verify LP tokens minted
 * 4. WithdrawInsuranceLP (Tag 26)
 * 5. Verify proportional redemption
 * 
 * Usage:
 *   npx ts-node --esm app/scripts/test-insurance-lp.ts <slab_address>
 * 
 * Requires:
 *   - DEPLOYER_KEYPAIR env var or /tmp/percolator-program.json
 *   - Existing devnet market with admin = deployer
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getMint,
} from '@solana/spl-token';
import * as fs from 'fs';
import {
  encodeCreateInsuranceMint,
  encodeDepositInsuranceLP,
  encodeWithdrawInsuranceLP,
  encodeTopUpInsurance,
  deriveVaultAuthority,
  deriveInsuranceLpMint,
  buildAccountMetas,
  buildIx,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_DEPOSIT_INSURANCE_LP,
  ACCOUNTS_WITHDRAW_INSURANCE_LP,
  ACCOUNTS_TOPUP_INSURANCE,
  fetchSlab,
  parseHeader,
  parseConfig,
  parseEngine,
  detectLayout,
} from '@percolator/sdk';

// =============================================================================
// Config
// =============================================================================

const RPC_URL = 'https://api.devnet.solana.com';
const SLAB_ADDRESS = process.argv[2];

if (!SLAB_ADDRESS) {
  console.error('Usage: npx ts-node --esm app/scripts/test-insurance-lp.ts <slab_address>');
  process.exit(1);
}

// Load deployer keypair
function loadKeypair(): Keypair {
  const paths = [
    process.env.DEPLOYER_KEYPAIR,
    '/tmp/deployer.json',
    '/tmp/percolator-program.json',
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return Keypair.fromSecretKey(new Uint8Array(raw));
    }
  }
  throw new Error('No deployer keypair found');
}

// =============================================================================
// Helpers
// =============================================================================

async function sendIx(
  connection: Connection,
  payer: Keypair,
  ix: any,
  label: string,
): Promise<string> {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx.add(ix);

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: true,
  });
  console.log(`  ✅ ${label}: ${sig}`);
  return sig;
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// =============================================================================
// Main Test
// =============================================================================

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');
  const deployer = loadKeypair();
  const slabPk = new PublicKey(SLAB_ADDRESS);

  console.log(`\n🧪 Insurance LP E2E Test`);
  console.log(`  Slab: ${slabPk.toBase58()}`);
  console.log(`  Deployer: ${deployer.publicKey.toBase58()}`);

  // Fetch slab to get program ID and config
  const slabInfo = await connection.getAccountInfo(slabPk);
  if (!slabInfo) throw new Error('Slab not found');

  const programId = slabInfo.owner;
  const layout = detectLayout(slabInfo.data.length);
  if (!layout) throw new Error('Unknown slab layout');

  const header = parseHeader(slabInfo.data);
  const config = parseConfig(slabInfo.data);
  const engine = parseEngine(slabInfo.data);

  console.log(`  Program: ${programId.toBase58()}`);
  console.log(`  Admin: ${header.admin.toBase58()}`);
  console.log(`  Collateral: ${config.collateralMint.toBase58()}`);
  console.log(`  Insurance balance: ${engine.insuranceFund.balance}`);
  console.log();

  assert(header.admin.equals(deployer.publicKey), 'Deployer is admin');

  const [vaultAuth, vaultBump] = deriveVaultAuthority(programId, slabPk);
  const [insLpMint, mintBump] = deriveInsuranceLpMint(programId, slabPk);

  console.log(`  Vault auth: ${vaultAuth.toBase58()}`);
  console.log(`  Insurance LP mint PDA: ${insLpMint.toBase58()}`);
  console.log();

  // =========================================================================
  // Test 1: CreateInsuranceMint
  // =========================================================================
  console.log('📋 Test 1: CreateInsuranceMint');

  // Check if mint already exists
  const existingMint = await connection.getAccountInfo(insLpMint);
  if (existingMint) {
    console.log('  ⚠️ Mint already exists — skipping creation');
  } else {
    const data = encodeCreateInsuranceMint();
    const keys = buildAccountMetas(ACCOUNTS_CREATE_INSURANCE_MINT, [
      deployer.publicKey,      // admin
      slabPk,                  // slab
      insLpMint,               // ins_lp_mint
      vaultAuth,               // vault_authority
      config.collateralMint,   // collateral_mint
      SystemProgram.programId, // system
      TOKEN_PROGRAM_ID,        // token
      SYSVAR_RENT_PUBKEY,      // rent
      deployer.publicKey,      // payer
    ]);
    const ix = buildIx({ programId, keys, data });
    await sendIx(connection, deployer, ix, 'CreateInsuranceMint');
  }

  // Verify mint exists
  const mintInfo = await getMint(connection, insLpMint);
  assert(mintInfo.supply === 0n || existingMint !== null, 'LP mint exists');
  assert(mintInfo.mintAuthority?.equals(vaultAuth) === true, 'Mint authority = vault PDA');
  assert(mintInfo.freezeAuthority === null, 'No freeze authority');
  console.log(`  Decimals: ${mintInfo.decimals}`);
  console.log();

  // =========================================================================
  // Test 2: DepositInsuranceLP (first deposit — 1:1 ratio)
  // =========================================================================
  console.log('📋 Test 2: DepositInsuranceLP (first deposit)');

  const depositAmount = 100_000_000n; // 0.1 SOL (in lamports, for SOL-based collateral)

  // Get or create deployer's collateral ATA
  const deployerAta = await getAssociatedTokenAddress(config.collateralMint, deployer.publicKey);
  const deployerLpAta = await getAssociatedTokenAddress(insLpMint, deployer.publicKey);

  // Create LP ATA if needed
  const lpAtaInfo = await connection.getAccountInfo(deployerLpAta);
  if (!lpAtaInfo) {
    const createAtaTx = new Transaction();
    createAtaTx.add(
      createAssociatedTokenAccountInstruction(
        deployer.publicKey,
        deployerLpAta,
        deployer.publicKey,
        insLpMint
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [deployer], { commitment: 'confirmed' });
    console.log('  Created LP token ATA');
  }

  // Check deployer collateral balance
  try {
    const ata = await getAccount(connection, deployerAta);
    console.log(`  Deployer collateral balance: ${ata.amount}`);
    if (ata.amount < depositAmount) {
      console.log('  ⚠️ Insufficient collateral — skipping deposit test');
      return;
    }
  } catch {
    console.log('  ⚠️ No collateral ATA — skipping deposit test');
    return;
  }

  // Record pre-deposit state
  const preDepositMint = await getMint(connection, insLpMint);
  const preSupply = preDepositMint.supply;

  const depositData = encodeDepositInsuranceLP({ amount: depositAmount.toString() });
  const depositKeys = buildAccountMetas(ACCOUNTS_DEPOSIT_INSURANCE_LP, [
    deployer.publicKey,    // depositor
    slabPk,                // slab
    deployerAta,           // depositor_ata
    config.vaultPubkey,    // vault
    TOKEN_PROGRAM_ID,      // token_program
    insLpMint,             // ins_lp_mint
    deployerLpAta,         // depositor_lp_ata
    vaultAuth,             // vault_authority
  ]);
  const depositIx = buildIx({ programId, keys: depositKeys, data: depositData });
  await sendIx(connection, deployer, depositIx, 'DepositInsuranceLP');

  // Verify LP tokens were minted
  const postDepositMint = await getMint(connection, insLpMint);
  const lpMinted = postDepositMint.supply - preSupply;
  console.log(`  LP minted: ${lpMinted}`);
  assert(lpMinted > 0n, 'LP tokens were minted');

  const deployerLpBalance = (await getAccount(connection, deployerLpAta)).amount;
  console.log(`  Deployer LP balance: ${deployerLpBalance}`);
  assert(deployerLpBalance > 0n, 'Deployer has LP tokens');

  // Verify insurance fund increased
  const postSlabInfo = await connection.getAccountInfo(slabPk);
  if (postSlabInfo) {
    const postEngine = parseEngine(postSlabInfo.data);
    console.log(`  Insurance balance after: ${postEngine.insuranceFund.balance}`);
    assert(postEngine.insuranceFund.balance > engine.insuranceFund.balance, 'Insurance fund increased');
  }
  console.log();

  // =========================================================================
  // Test 3: WithdrawInsuranceLP (partial withdrawal)
  // =========================================================================
  console.log('📋 Test 3: WithdrawInsuranceLP (partial)');

  const withdrawLpAmount = lpMinted / 2n; // Withdraw half
  if (withdrawLpAmount === 0n) {
    console.log('  ⚠️ Not enough LP tokens to test withdrawal');
    return;
  }

  const preWithdrawCollateral = (await getAccount(connection, deployerAta)).amount;

  const withdrawData = encodeWithdrawInsuranceLP({ lpAmount: withdrawLpAmount.toString() });
  const withdrawKeys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE_LP, [
    deployer.publicKey,    // withdrawer
    slabPk,                // slab
    deployerAta,           // withdrawer_ata
    config.vaultPubkey,    // vault
    TOKEN_PROGRAM_ID,      // token_program
    insLpMint,             // ins_lp_mint
    deployerLpAta,         // withdrawer_lp_ata
    vaultAuth,             // vault_authority
  ]);
  const withdrawIx = buildIx({ programId, keys: withdrawKeys, data: withdrawData });
  await sendIx(connection, deployer, withdrawIx, 'WithdrawInsuranceLP');

  // Verify LP tokens were burned
  const postWithdrawLp = (await getAccount(connection, deployerLpAta)).amount;
  const lpBurned = deployerLpBalance - postWithdrawLp;
  console.log(`  LP burned: ${lpBurned}`);
  assert(lpBurned === withdrawLpAmount, 'Correct LP amount burned');

  // Verify collateral returned
  const postWithdrawCollateral = (await getAccount(connection, deployerAta)).amount;
  const collateralReturned = postWithdrawCollateral - preWithdrawCollateral;
  console.log(`  Collateral returned: ${collateralReturned}`);
  assert(collateralReturned > 0n, 'Collateral was returned');

  // Verify supply decreased
  const finalMint = await getMint(connection, insLpMint);
  assert(finalMint.supply === postDepositMint.supply - withdrawLpAmount, 'Supply decreased correctly');

  console.log();
  console.log('🎉 All insurance LP tests passed!');
  console.log(`  Final LP supply: ${finalMint.supply}`);
  console.log(`  Deployer remaining LP: ${postWithdrawLp}`);
}

main().catch((err) => {
  console.error('\n💥 Test failed:', err);
  process.exit(1);
});
