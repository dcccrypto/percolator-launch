/**
 * E2E CPI Integration Tests — percolator-stake SDK
 *
 * Verifies the full stake lifecycle at the instruction-building level:
 * InitPool → Deposit → Withdraw → FlushToInsurance → Admin CPI forwarding
 *
 * These tests validate that:
 * 1. Instructions are built with correct account ordering, signer/writable flags
 * 2. The CPI flow from stake → percolator produces correct account specs
 * 3. PDA seeds chain correctly across the full lifecycle
 * 4. Encoded instruction data matches expected byte layouts
 *
 * NOTE: This runs in a mocked environment (no real Solana validator).
 * For on-chain devnet tests, see tests/t*-stake*.ts.
 */

import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  STAKE_PROGRAM_ID,
  STAKE_IX,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  encodeStakeInitPool,
  encodeStakeDeposit,
  encodeStakeWithdraw,
  encodeStakeFlushToInsurance,
  encodeStakeUpdateConfig,
  encodeStakeTransferAdmin,
  encodeStakeAdminSetOracleAuthority,
  encodeStakeAdminSetRiskThreshold,
  encodeStakeAdminSetMaintenanceFee,
  encodeStakeAdminResolveMarket,
  encodeStakeAdminWithdrawInsurance,
  encodeStakeAdminSetInsurancePolicy,
  initPoolAccounts,
  depositAccounts,
  withdrawAccounts,
  flushToInsuranceAccounts,
} from '../stake.js';

// ═══════════════════════════════════════════════════════════════
// Test fixtures — simulate a realistic deployment scenario
// ═══════════════════════════════════════════════════════════════

const PERCOLATOR_PROGRAM = new PublicKey('EXsr2Tfz8ntWYP3vgCStdknFBoafvJQugJKAh4nFdo8f');
const admin = Keypair.generate();
const user = Keypair.generate();
const slab = Keypair.generate();
const collateralMint = Keypair.generate().publicKey;
const wrapperVault = Keypair.generate().publicKey;

// Derive all PDAs for the lifecycle
const [pool, poolBump] = deriveStakePool(slab.publicKey);
const [vaultAuth, vaultAuthBump] = deriveStakeVaultAuth(pool);
const [depositPda, depositPdaBump] = deriveDepositPda(pool, user.publicKey);

// Simulated token accounts
const userCollateralAta = Keypair.generate().publicKey;
const userLpAta = Keypair.generate().publicKey;
const lpMint = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;

// ═══════════════════════════════════════════════════════════════
// E2E CPI Lifecycle Tests
// ═══════════════════════════════════════════════════════════════

describe('Stake CPI Integration — Full Lifecycle', () => {
  describe('Phase 1: Pool Initialization', () => {
    it('initPool instruction has correct account count and order', () => {
      const keys = initPoolAccounts({
        admin: admin.publicKey,
        slab: slab.publicKey,
        pool,
        lpMint,
        vault,
        vaultAuth,
        collateralMint,
        percolatorProgram: PERCOLATOR_PROGRAM,
      });

      // 11 accounts: admin, slab, pool, lpMint, vault, vaultAuth, collateralMint,
      //              percolatorProgram, tokenProgram, systemProgram, rent
      expect(keys).toHaveLength(11);

      // Account 0: admin — must be signer + writable (pays rent)
      expect(keys[0].pubkey.equals(admin.publicKey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);
      expect(keys[0].isWritable).toBe(true);

      // Account 1: slab — read-only (stake reads slab config but doesn't mutate it)
      expect(keys[1].pubkey.equals(slab.publicKey)).toBe(true);
      expect(keys[1].isSigner).toBe(false);
      expect(keys[1].isWritable).toBe(false);

      // Account 2: pool PDA — writable (created in this ix)
      expect(keys[2].pubkey.equals(pool)).toBe(true);
      expect(keys[2].isWritable).toBe(true);

      // Account 3: LP mint — writable (created)
      expect(keys[3].isWritable).toBe(true);

      // Account 4: vault — writable (created)
      expect(keys[4].isWritable).toBe(true);

      // Account 5: vault authority — read-only PDA
      expect(keys[5].pubkey.equals(vaultAuth)).toBe(true);
      expect(keys[5].isWritable).toBe(false);

      // Account 6: collateral mint — read-only
      expect(keys[6].isWritable).toBe(false);

      // Accounts 7-10: programs and sysvars — all read-only
      expect(keys[7].pubkey.equals(PERCOLATOR_PROGRAM)).toBe(true);
      expect(keys[8].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(keys[9].pubkey.equals(SystemProgram.programId)).toBe(true);
      expect(keys[10].pubkey.equals(SYSVAR_RENT_PUBKEY)).toBe(true);
    });

    it('initPool data encodes tag 0 + cooldown + cap', () => {
      const data = encodeStakeInitPool(300n, 10_000_000n);
      expect(data[0]).toBe(STAKE_IX.InitPool);
      expect(data.readBigUInt64LE(1)).toBe(300n);
      expect(data.readBigUInt64LE(9)).toBe(10_000_000n);
      expect(data.length).toBe(17); // 1 tag + 8 cooldown + 8 cap
    });
  });

  describe('Phase 2: User Deposit', () => {
    it('deposit instruction has correct account count and flags', () => {
      const keys = depositAccounts({
        user: user.publicKey,
        pool,
        userCollateralAta,
        vault,
        lpMint,
        userLpAta,
        vaultAuth,
        depositPda,
      });

      // 11 accounts
      expect(keys).toHaveLength(11);

      // Account 0: user — signer (signs the transfer)
      expect(keys[0].pubkey.equals(user.publicKey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);
      expect(keys[0].isWritable).toBe(false);

      // Account 1: pool — writable (updates total_deposited)
      expect(keys[1].pubkey.equals(pool)).toBe(true);
      expect(keys[1].isWritable).toBe(true);

      // Accounts 2-5: token accounts — all writable
      expect(keys[2].isWritable).toBe(true); // userCollateralAta
      expect(keys[3].isWritable).toBe(true); // vault
      expect(keys[4].isWritable).toBe(true); // lpMint (mints LP tokens)
      expect(keys[5].isWritable).toBe(true); // userLpAta

      // Account 6: vault authority — read-only (signer via PDA)
      expect(keys[6].pubkey.equals(vaultAuth)).toBe(true);
      expect(keys[6].isWritable).toBe(false);

      // Account 7: deposit PDA — writable (created/updated)
      expect(keys[7].pubkey.equals(depositPda)).toBe(true);
      expect(keys[7].isWritable).toBe(true);

      // Account 8-10: programs
      expect(keys[8].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
      expect(keys[9].pubkey.equals(SYSVAR_CLOCK_PUBKEY)).toBe(true);
      expect(keys[10].pubkey.equals(SystemProgram.programId)).toBe(true);
    });

    it('deposit data encodes tag 1 + u64 amount', () => {
      const amount = 5_000_000n;
      const data = encodeStakeDeposit(amount);
      expect(data[0]).toBe(STAKE_IX.Deposit);
      expect(data.readBigUInt64LE(1)).toBe(amount);
      expect(data.length).toBe(9); // 1 tag + 8 amount
    });
  });

  describe('Phase 3: User Withdraw', () => {
    it('withdraw instruction accounts in correct order', () => {
      const keys = withdrawAccounts({
        user: user.publicKey,
        pool,
        userLpAta,
        lpMint,
        vault,
        userCollateralAta,
        vaultAuth,
        depositPda,
      });

      // 10 accounts (no systemProgram needed — deposit PDA already exists)
      expect(keys).toHaveLength(10);

      // Account 0: user — signer
      expect(keys[0].pubkey.equals(user.publicKey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);

      // Account 1: pool — writable (updates total_deposited)
      expect(keys[1].pubkey.equals(pool)).toBe(true);
      expect(keys[1].isWritable).toBe(true);

      // Accounts 2-5: token accounts — all writable
      expect(keys[2].isWritable).toBe(true); // userLpAta (burned from)
      expect(keys[3].isWritable).toBe(true); // lpMint (burn supply)
      expect(keys[4].isWritable).toBe(true); // vault (transfer out)
      expect(keys[5].isWritable).toBe(true); // userCollateralAta (transfer to)

      // Account 6: vault authority — read-only
      expect(keys[6].pubkey.equals(vaultAuth)).toBe(true);
      expect(keys[6].isWritable).toBe(false);

      // Account 7: deposit PDA — writable (updated for cooldown)
      expect(keys[7].pubkey.equals(depositPda)).toBe(true);
      expect(keys[7].isWritable).toBe(true);
    });

    it('withdraw data encodes tag 2 + u64 lpAmount', () => {
      const lpAmount = 2_500_000n;
      const data = encodeStakeWithdraw(lpAmount);
      expect(data[0]).toBe(STAKE_IX.Withdraw);
      expect(data.readBigUInt64LE(1)).toBe(lpAmount);
      expect(data.length).toBe(9);
    });
  });

  describe('Phase 4: FlushToInsurance (CPI from stake → percolator)', () => {
    it('flushToInsurance accounts include CPI targets', () => {
      const keys = flushToInsuranceAccounts({
        caller: admin.publicKey,
        pool,
        vault,
        vaultAuth,
        slab: slab.publicKey,
        wrapperVault,
        percolatorProgram: PERCOLATOR_PROGRAM,
      });

      // 8 accounts
      expect(keys).toHaveLength(8);

      // Account 0: caller — signer (permissioned flush)
      expect(keys[0].pubkey.equals(admin.publicKey)).toBe(true);
      expect(keys[0].isSigner).toBe(true);

      // Account 1: pool — writable (update flush accounting)
      expect(keys[1].pubkey.equals(pool)).toBe(true);
      expect(keys[1].isWritable).toBe(true);

      // Account 2: vault — writable (source of CPI transfer)
      expect(keys[2].pubkey.equals(vault)).toBe(true);
      expect(keys[2].isWritable).toBe(true);

      // Account 3: vault authority — read-only (PDA signer for CPI)
      expect(keys[3].pubkey.equals(vaultAuth)).toBe(true);
      expect(keys[3].isWritable).toBe(false);

      // Account 4: slab — writable (CPI target: percolator slab account)
      expect(keys[4].pubkey.equals(slab.publicKey)).toBe(true);
      expect(keys[4].isWritable).toBe(true);

      // Account 5: wrapper vault — writable (CPI target: receives tokens)
      expect(keys[5].pubkey.equals(wrapperVault)).toBe(true);
      expect(keys[5].isWritable).toBe(true);

      // Account 6: percolator program — the CPI target program
      expect(keys[6].pubkey.equals(PERCOLATOR_PROGRAM)).toBe(true);
      expect(keys[6].isWritable).toBe(false);

      // Account 7: token program
      expect(keys[7].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    });

    it('flushToInsurance data encodes tag 3 + u64 amount', () => {
      const data = encodeStakeFlushToInsurance(1_000_000n);
      expect(data[0]).toBe(STAKE_IX.FlushToInsurance);
      expect(data.readBigUInt64LE(1)).toBe(1_000_000n);
      expect(data.length).toBe(9);
    });

    it('vault authority PDA chains correctly for CPI signing', () => {
      // The vault authority is derived from pool, which is derived from slab.
      // This chain must be deterministic for the CPI to work on-chain.
      const [pool2] = deriveStakePool(slab.publicKey);
      const [vaultAuth2] = deriveStakeVaultAuth(pool2);

      // Same slab → same pool → same vault authority
      expect(pool2.equals(pool)).toBe(true);
      expect(vaultAuth2.equals(vaultAuth)).toBe(true);

      // Different slab → different chain
      const otherSlab = Keypair.generate();
      const [otherPool] = deriveStakePool(otherSlab.publicKey);
      const [otherVaultAuth] = deriveStakeVaultAuth(otherPool);
      expect(otherPool.equals(pool)).toBe(false);
      expect(otherVaultAuth.equals(vaultAuth)).toBe(false);
    });
  });

  describe('Phase 5: Admin CPI Forwarding', () => {
    it('AdminSetOracleAuthority encodes pubkey for CPI', () => {
      const newAuth = Keypair.generate().publicKey;
      const data = encodeStakeAdminSetOracleAuthority(newAuth);
      expect(data[0]).toBe(STAKE_IX.AdminSetOracleAuthority);
      expect(Buffer.from(data.subarray(1, 33))).toEqual(newAuth.toBuffer());
      expect(data.length).toBe(33); // 1 tag + 32 pubkey
    });

    it('AdminSetRiskThreshold encodes u128 for CPI', () => {
      const bigThreshold = (1n << 96n) + 42n; // exercises high word
      const data = encodeStakeAdminSetRiskThreshold(bigThreshold);
      expect(data[0]).toBe(STAKE_IX.AdminSetRiskThreshold);
      const lo = data.readBigUInt64LE(1);
      const hi = data.readBigUInt64LE(9);
      expect(lo + (hi << 64n)).toBe(bigThreshold);
      expect(data.length).toBe(17); // 1 tag + 16 u128
    });

    it('AdminSetMaintenanceFee encodes u128 for CPI', () => {
      const data = encodeStakeAdminSetMaintenanceFee(500n);
      expect(data[0]).toBe(STAKE_IX.AdminSetMaintenanceFee);
      const lo = data.readBigUInt64LE(1);
      const hi = data.readBigUInt64LE(9);
      expect(lo + (hi << 64n)).toBe(500n);
    });

    it('AdminResolveMarket encodes tag-only', () => {
      const data = encodeStakeAdminResolveMarket();
      expect(data[0]).toBe(STAKE_IX.AdminResolveMarket);
      expect(data.length).toBe(1);
    });

    it('AdminWithdrawInsurance encodes u64 amount', () => {
      const data = encodeStakeAdminWithdrawInsurance(777_000n);
      expect(data[0]).toBe(STAKE_IX.AdminWithdrawInsurance);
      expect(data.readBigUInt64LE(1)).toBe(777_000n);
      expect(data.length).toBe(9);
    });

    it('AdminSetInsurancePolicy encodes pubkey + u64 + u16 + u64', () => {
      const authority = Keypair.generate().publicKey;
      const data = encodeStakeAdminSetInsurancePolicy(authority, 100_000n, 500, 100n);
      expect(data[0]).toBe(STAKE_IX.AdminSetInsurancePolicy);
      // 1 tag + 32 pubkey + 8 minWithdrawBase + 2 maxWithdrawBps + 8 cooldownSlots = 51
      expect(data.length).toBe(51);
      expect(Buffer.from(data.subarray(1, 33))).toEqual(authority.toBuffer());
      expect(data.readBigUInt64LE(33)).toBe(100_000n);
      expect(data.readUInt16LE(41)).toBe(500);
      expect(data.readBigUInt64LE(43)).toBe(100n);
    });

    it('TransferAdmin is tag-only', () => {
      const data = encodeStakeTransferAdmin();
      expect(data[0]).toBe(STAKE_IX.TransferAdmin);
      expect(data.length).toBe(1);
    });

    it('UpdateConfig encodes optional fields correctly', () => {
      // Both set
      const both = encodeStakeUpdateConfig(300n, 10_000_000n);
      expect(both[0]).toBe(STAKE_IX.UpdateConfig);
      expect(both[1]).toBe(1); // has_cooldown
      expect(both.readBigUInt64LE(2)).toBe(300n);
      expect(both[10]).toBe(1); // has_cap
      expect(both.readBigUInt64LE(11)).toBe(10_000_000n);

      // Only cooldown
      const cooldownOnly = encodeStakeUpdateConfig(200n, undefined);
      expect(cooldownOnly[1]).toBe(1);
      expect(cooldownOnly.readBigUInt64LE(2)).toBe(200n);
      expect(cooldownOnly[10]).toBe(0);
      expect(cooldownOnly.readBigUInt64LE(11)).toBe(0n);

      // Only cap
      const capOnly = encodeStakeUpdateConfig(undefined, 500n);
      expect(capOnly[1]).toBe(0);
      expect(capOnly.readBigUInt64LE(2)).toBe(0n);
      expect(capOnly[10]).toBe(1);
      expect(capOnly.readBigUInt64LE(11)).toBe(500n);

      // Neither
      const neither = encodeStakeUpdateConfig(undefined, undefined);
      expect(neither[1]).toBe(0);
      expect(neither[10]).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PDA Chain Integrity Tests
// ═══════════════════════════════════════════════════════════════

describe('Stake PDA Chain — Multi-Market Isolation', () => {
  it('each slab produces an isolated PDA chain', () => {
    const slabs = Array.from({ length: 5 }, () => Keypair.generate().publicKey);
    const chains = slabs.map((s) => {
      const [p] = deriveStakePool(s);
      const [va] = deriveStakeVaultAuth(p);
      const [dp] = deriveDepositPda(p, user.publicKey);
      return { pool: p, vaultAuth: va, depositPda: dp };
    });

    // All pools are unique
    const poolSet = new Set(chains.map((c) => c.pool.toBase58()));
    expect(poolSet.size).toBe(5);

    // All vault authorities are unique
    const vaSet = new Set(chains.map((c) => c.vaultAuth.toBase58()));
    expect(vaSet.size).toBe(5);

    // All deposit PDAs are unique
    const dpSet = new Set(chains.map((c) => c.depositPda.toBase58()));
    expect(dpSet.size).toBe(5);
  });

  it('same slab + different users → unique deposit PDAs, same pool', () => {
    const [sharedPool] = deriveStakePool(slab.publicKey);
    const users = Array.from({ length: 10 }, () => Keypair.generate().publicKey);
    const depositPdas = users.map((u) => deriveDepositPda(sharedPool, u)[0].toBase58());

    const uniquePdas = new Set(depositPdas);
    expect(uniquePdas.size).toBe(10);
  });

  it('deposit PDA determinism — same inputs always produce same output', () => {
    for (let i = 0; i < 100; i++) {
      const [dp] = deriveDepositPda(pool, user.publicKey);
      expect(dp.equals(depositPda)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Instruction Tag Consistency
// ═══════════════════════════════════════════════════════════════

describe('Stake Instruction Tags — No Gaps or Conflicts', () => {
  it('tags are contiguous 0..11', () => {
    const tags = Object.values(STAKE_IX);
    expect(tags).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('each encoder produces the correct tag byte', () => {
    const tagMap: [number, Buffer][] = [
      [STAKE_IX.InitPool, encodeStakeInitPool(0n, 0n)],
      [STAKE_IX.Deposit, encodeStakeDeposit(0n)],
      [STAKE_IX.Withdraw, encodeStakeWithdraw(0n)],
      [STAKE_IX.FlushToInsurance, encodeStakeFlushToInsurance(0n)],
      [STAKE_IX.UpdateConfig, encodeStakeUpdateConfig()],
      [STAKE_IX.TransferAdmin, encodeStakeTransferAdmin()],
      [STAKE_IX.AdminSetOracleAuthority, encodeStakeAdminSetOracleAuthority(PublicKey.default)],
      [STAKE_IX.AdminSetRiskThreshold, encodeStakeAdminSetRiskThreshold(0n)],
      [STAKE_IX.AdminSetMaintenanceFee, encodeStakeAdminSetMaintenanceFee(0n)],
      [STAKE_IX.AdminResolveMarket, encodeStakeAdminResolveMarket()],
      [STAKE_IX.AdminWithdrawInsurance, encodeStakeAdminWithdrawInsurance(0n)],
      [STAKE_IX.AdminSetInsurancePolicy, encodeStakeAdminSetInsurancePolicy(PublicKey.default, 0n, 0, 0n)],
    ];

    for (const [expectedTag, data] of tagMap) {
      expect(data[0]).toBe(expectedTag);
    }
  });
});
