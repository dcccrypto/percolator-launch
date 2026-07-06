// Fix-up: complete TX5 (TopUpInsurance, with clock) and TX6 (InitStakePool)
// for the market that was launched but stopped at TX4 due to a missing
// `clock` account in the original script.
//
// Slab: H7CVBttJmyAiae3bsKSCz8DbrPtKwMhs4NeFmQ9okhpz

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram,
  SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, MINT_SIZE, ACCOUNT_SIZE as TOKEN_ACCOUNT_SIZE,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { encodeTopUpInsurance } from '@percolatorct/sdk';
import fs from 'fs';
import os from 'os';
import path from 'path';

const RPC = 'https://api.mainnet-beta.solana.com';
const PROGRAM_ID = new PublicKey('ESa89R5Es3rJ5mnwGybVRG1GrNt9etP11Z5V2QWD4edv');
const STAKE_PROG_ID = new PublicKey('DC5fovFQD5SZYsetwvEqd4Wi4PFY1Yfnc669VMe6oa7F');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ADMIN_KEY = path.join(os.homedir(), '.percolator-mainnet', 'keys', 'deploy-authority.json');

// Live market addresses from the partial run
const SLAB = new PublicKey('H7CVBttJmyAiae3bsKSCz8DbrPtKwMhs4NeFmQ9okhpz');
// Backup dir for stake keypairs
const BACKUP_DIR = '/Users/khubair/.percolator-mainnet/markets/mainnet-2026-05-01T03-04-24-793Z';

const INSURANCE_AMOUNT = 20_000_000n; // 20 USDC
const STAKE_COOLDOWN_SLOTS = 300n;
const STAKE_DEPOSIT_CAP = 0n;

const conn = new Connection(RPC, 'confirmed');
const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(ADMIN_KEY, 'utf8'))));

// Stake keypairs were never generated (original script crashed at TX5
// before reaching TX6). Generate fresh and save immediately.
const stakeLpMint = Keypair.generate();
const stakeVault = Keypair.generate();
const saveKp = (name, kp) => {
  const p = path.join(BACKUP_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`  saved keypair: ${p}`);
};
saveKp('stake-lp-mint', stakeLpMint);
saveKp('stake-vault', stakeVault);

console.log('Admin:           ', admin.publicKey.toBase58());
console.log('Slab:            ', SLAB.toBase58());

// Derive vault PDA + vault ATA
const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), SLAB.toBuffer()], PROGRAM_ID);
const vaultAta = await getAssociatedTokenAddress(USDC_MINT, vaultPda, true);
const adminAta = await getAssociatedTokenAddress(USDC_MINT, admin.publicKey);

console.log('Vault PDA:       ', vaultPda.toBase58());
console.log('Vault ATA:       ', vaultAta.toBase58());

// ── TX5: TopUpInsurance (with clock) ────────────────────────────────────────
console.log('\nTX5: TopUpInsurance (20 USDC, with clock account)...');
const tx5 = new Transaction();
tx5.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }));
tx5.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
tx5.add(new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: admin.publicKey,       isSigner: true,  isWritable: true },  // user
    { pubkey: SLAB,                  isSigner: false, isWritable: true },  // slab
    { pubkey: adminAta,              isSigner: false, isWritable: true },  // userAta
    { pubkey: vaultAta,              isSigner: false, isWritable: true },  // vault
    { pubkey: TOKEN_PROGRAM_ID,      isSigner: false, isWritable: false }, // tokenProgram
    { pubkey: SYSVAR_CLOCK_PUBKEY,   isSigner: false, isWritable: false }, // clock (new in v12.19)
  ],
  data: Buffer.from(encodeTopUpInsurance({ amount: INSURANCE_AMOUNT })),
}));

const { blockhash: bh5 } = await conn.getLatestBlockhash('confirmed');
tx5.recentBlockhash = bh5;
tx5.feePayer = admin.publicKey;
const sig5 = await sendAndConfirmTransaction(conn, tx5, [admin], { commitment: 'confirmed', maxRetries: 3 });
console.log(`  TX5: https://solscan.io/tx/${sig5}`);

// ── TX6: InitStakePool ──────────────────────────────────────────────────────
console.log('\nTX6: InitStakePool...');
const [stakePool] = PublicKey.findProgramAddressSync([Buffer.from('stake_pool'), SLAB.toBuffer()], STAKE_PROG_ID);
const [stakeVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault_auth'), stakePool.toBuffer()], STAKE_PROG_ID);
console.log('  Stake pool PDA:   ', stakePool.toBase58());
console.log('  Stake LP mint:    ', stakeLpMint.publicKey.toBase58());
console.log('  Stake vault:      ', stakeVault.publicKey.toBase58());
console.log('  Stake vault auth: ', stakeVaultAuth.toBase58());

const stakeMintRent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
const stakeTokenRent = await conn.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);

const tx6 = new Transaction();
tx6.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
tx6.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
tx6.add(SystemProgram.createAccount({
  fromPubkey: admin.publicKey, newAccountPubkey: stakeLpMint.publicKey,
  lamports: stakeMintRent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
}));
tx6.add(SystemProgram.createAccount({
  fromPubkey: admin.publicKey, newAccountPubkey: stakeVault.publicKey,
  lamports: stakeTokenRent, space: TOKEN_ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
}));
const initPoolData = Buffer.concat([
  Buffer.from([0]),
  (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(STAKE_COOLDOWN_SLOTS); return b; })(),
  (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(STAKE_DEPOSIT_CAP); return b; })(),
]);
tx6.add(new TransactionInstruction({
  programId: STAKE_PROG_ID,
  keys: [
    { pubkey: admin.publicKey,         isSigner: true,  isWritable: true },
    { pubkey: SLAB,                    isSigner: false, isWritable: false },
    { pubkey: stakePool,               isSigner: false, isWritable: true },
    { pubkey: stakeLpMint.publicKey,   isSigner: false, isWritable: true },
    { pubkey: stakeVault.publicKey,    isSigner: false, isWritable: true },
    { pubkey: stakeVaultAuth,          isSigner: false, isWritable: false },
    { pubkey: USDC_MINT,               isSigner: false, isWritable: false },
    { pubkey: PROGRAM_ID,              isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
  ],
  data: initPoolData,
}));

const { blockhash: bh6 } = await conn.getLatestBlockhash('confirmed');
tx6.recentBlockhash = bh6;
tx6.feePayer = admin.publicKey;
let sig6;
try {
  sig6 = await sendAndConfirmTransaction(conn, tx6, [admin, stakeLpMint, stakeVault], { commitment: 'confirmed', maxRetries: 3 });
  console.log(`  TX6: https://solscan.io/tx/${sig6}`);
} catch (e) {
  console.warn('TX6 InitStakePool failed (non-fatal):', e instanceof Error ? e.message : e);
  console.warn('Market is fully functional without the stake pool. Can be added later.');
}

// ── Final market.json ───────────────────────────────────────────────────────
const marketJson = {
  programId: PROGRAM_ID.toBase58(),
  slabAddress: SLAB.toBase58(),
  matcherCtxAddress: 'B4zfX5jayXZkh2emrKXvEbAkvoCQH24tpCf7oce6MdHh',
  lpPda: '9Y32Vn73Qyj5jg7Bdae6ZLcFwYNRErTnBPyUTE5FCTCi',
  vaultAta: vaultAta.toBase58(),
  vaultPda: vaultPda.toBase58(),
  collateralMint: USDC_MINT.toBase58(),
  dexPool: '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv',
  stakePool: stakePool.toBase58(),
  stakeLpMint: stakeLpMint.publicKey.toBase58(),
  stakeVault: stakeVault.publicKey.toBase58(),
  stakeVaultAuth: stakeVaultAuth.toBase58(),
  stakeProgramId: STAKE_PROG_ID.toBase58(),
  network: 'mainnet',
  createdAt: new Date().toISOString(),
  transactions: {
    sig1_initMarket:     'g1h1VrwRhF8siDyeKCoWqjhkagfj8rpAoXDtVPGxEJqHgxHFTYKjczDDRL6jkPCo2kafYqbcrbnCHsEmcFtRXno',
    sig2_setDexPool:     '36NCfLwxspEqhFb5eRa7S36GpypkpSFVVPxCoDYYEM9PwF4BkJFqpLv2SMG2nwHaJEEpntyRXD6iv5C2cK1rhcyM',
    sig3_initLp:         'MWvA2KSnGH4x8cQn1F6vSceVKQX9gPBM3nM55fziH1id1T5HbgAZu494ve8uB6A1Ymnwk7gxUu9VqEjxygqBwXw',
    sig4_initMatcherCtx: '676Cvw6rWPBxuboaquM3xNozS3mtcqckqm6JgAne5VcjLH8476z6QA69ti2Y9Q3LbUKG3FazAanb9duz4Pod7UQK',
    sig5_topUpInsurance: sig5,
    sig6_initStakePool:  sig6 ?? null,
  },
};

const outFile = path.join(BACKUP_DIR, 'market.json');
fs.writeFileSync(outFile, JSON.stringify(marketJson, null, 2));
console.log(`\nMarket config saved: ${outFile}`);
console.log('\n========== MARKET COMPLETE ==========');
console.log('Slab:', SLAB.toBase58());
console.log('Solscan:', `https://solscan.io/account/${SLAB.toBase58()}`);
