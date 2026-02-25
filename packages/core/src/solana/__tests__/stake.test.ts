import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
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
const slab = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;

describe('STAKE_PROGRAM_ID', () => {
  it('is a valid public key', () => {
    expect(STAKE_PROGRAM_ID.toBase58()).toBe('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc');
  });
});

describe('STAKE_IX tags', () => {
  it('has correct tag values matching Rust instruction.rs', () => {
    expect(STAKE_IX.InitPool).toBe(0);
    expect(STAKE_IX.Deposit).toBe(1);
    expect(STAKE_IX.Withdraw).toBe(2);
    expect(STAKE_IX.FlushToInsurance).toBe(3);
    expect(STAKE_IX.UpdateConfig).toBe(4);
    expect(STAKE_IX.TransferAdmin).toBe(5);
    expect(STAKE_IX.AdminSetOracleAuthority).toBe(6);
    expect(STAKE_IX.AdminSetRiskThreshold).toBe(7);
    expect(STAKE_IX.AdminSetMaintenanceFee).toBe(8);
    expect(STAKE_IX.AdminResolveMarket).toBe(9);
    expect(STAKE_IX.AdminWithdrawInsurance).toBe(10);
    expect(STAKE_IX.AdminSetInsurancePolicy).toBe(11);
  });
});

describe('PDA derivation', () => {
  it('deriveStakePool returns consistent PDA', () => {
    const [pda1, bump1] = deriveStakePool(slab);
    const [pda2, bump2] = deriveStakePool(slab);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
    expect(bump1).toBeGreaterThanOrEqual(0);
    expect(bump1).toBeLessThanOrEqual(255);
  });

  it('deriveStakePool differs by slab', () => {
    const [pda1] = deriveStakePool(slab);
    const [pda2] = deriveStakePool(user);
    expect(pda1.equals(pda2)).toBe(false);
  });

  it('deriveStakeVaultAuth returns consistent PDA', () => {
    const [pool] = deriveStakePool(slab);
    const [auth1] = deriveStakeVaultAuth(pool);
    const [auth2] = deriveStakeVaultAuth(pool);
    expect(auth1.equals(auth2)).toBe(true);
  });

  it('deriveDepositPda is per-user', () => {
    const [pool] = deriveStakePool(slab);
    const user2 = Keypair.generate().publicKey;
    const [dep1] = deriveDepositPda(pool, user);
    const [dep2] = deriveDepositPda(pool, user2);
    expect(dep1.equals(dep2)).toBe(false);
  });

  it('deriveDepositPda is per-pool', () => {
    const [pool1] = deriveStakePool(slab);
    const [pool2] = deriveStakePool(user);
    const [dep1] = deriveDepositPda(pool1, user);
    const [dep2] = deriveDepositPda(pool2, user);
    expect(dep1.equals(dep2)).toBe(false);
  });
});

describe('Instruction encoders', () => {
  it('encodeStakeInitPool — tag 0 + cooldown + cap', () => {
    const buf = encodeStakeInitPool(100n, 5000n);
    expect(buf[0]).toBe(0);
    expect(buf.length).toBe(1 + 8 + 8);
    expect(buf.readBigUInt64LE(1)).toBe(100n);
    expect(buf.readBigUInt64LE(9)).toBe(5000n);
  });

  it('encodeStakeDeposit — tag 1 + amount', () => {
    const buf = encodeStakeDeposit(42n);
    expect(buf[0]).toBe(1);
    expect(buf.length).toBe(9);
    expect(buf.readBigUInt64LE(1)).toBe(42n);
  });

  it('encodeStakeWithdraw — tag 2 + lp_amount', () => {
    const buf = encodeStakeWithdraw(999n);
    expect(buf[0]).toBe(2);
    expect(buf.readBigUInt64LE(1)).toBe(999n);
  });

  it('encodeStakeFlushToInsurance — tag 3 + amount', () => {
    const buf = encodeStakeFlushToInsurance(500n);
    expect(buf[0]).toBe(3);
    expect(buf.readBigUInt64LE(1)).toBe(500n);
  });

  it('encodeStakeUpdateConfig — both set', () => {
    const buf = encodeStakeUpdateConfig(200n, 1000n);
    expect(buf[0]).toBe(4);
    expect(buf[1]).toBe(1); // has_cooldown
    expect(buf.readBigUInt64LE(2)).toBe(200n);
    expect(buf[10]).toBe(1); // has_cap
    expect(buf.readBigUInt64LE(11)).toBe(1000n);
  });

  it('encodeStakeUpdateConfig — none set', () => {
    const buf = encodeStakeUpdateConfig();
    expect(buf[0]).toBe(4);
    expect(buf[1]).toBe(0); // no cooldown
    expect(buf[10]).toBe(0); // no cap
  });

  it('encodeStakeUpdateConfig — only cooldown set', () => {
    const buf = encodeStakeUpdateConfig(300n, undefined);
    expect(buf[1]).toBe(1);            // has_cooldown
    expect(buf.readBigUInt64LE(2)).toBe(300n);
    expect(buf[10]).toBe(0);           // no cap
    expect(buf.readBigUInt64LE(11)).toBe(0n);
  });

  it('encodeStakeUpdateConfig — only cap set', () => {
    const buf = encodeStakeUpdateConfig(undefined, 500n);
    expect(buf[1]).toBe(0);            // no cooldown
    expect(buf.readBigUInt64LE(2)).toBe(0n);
    expect(buf[10]).toBe(1);           // has_cap
    expect(buf.readBigUInt64LE(11)).toBe(500n);
  });

  it('encodeStakeTransferAdmin — tag 5, 1 byte', () => {
    const buf = encodeStakeTransferAdmin();
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(5);
  });

  it('encodeStakeAdminSetOracleAuthority — tag 6 + pubkey', () => {
    const auth = Keypair.generate().publicKey;
    const buf = encodeStakeAdminSetOracleAuthority(auth);
    expect(buf[0]).toBe(6);
    expect(buf.length).toBe(1 + 32);
    expect(new PublicKey(buf.subarray(1, 33)).equals(auth)).toBe(true);
  });

  it('encodeStakeAdminSetRiskThreshold — tag 7 + u128', () => {
    const buf = encodeStakeAdminSetRiskThreshold(12345n);
    expect(buf[0]).toBe(7);
    expect(buf.length).toBe(1 + 16);
    const lo = buf.readBigUInt64LE(1);
    const hi = buf.readBigUInt64LE(9);
    expect(lo + (hi << 64n)).toBe(12345n);
  });

  it('encodeStakeAdminSetRiskThreshold — exercises u128 high word', () => {
    const largeValue = (1n << 64n) + 1n; // requires non-zero high word
    const buf = encodeStakeAdminSetRiskThreshold(largeValue);
    const lo = buf.readBigUInt64LE(1);
    const hi = buf.readBigUInt64LE(9);
    expect(lo).toBe(1n);
    expect(hi).toBe(1n);
    expect(lo + (hi << 64n)).toBe(largeValue);
  });

  it('encodeStakeAdminSetMaintenanceFee — tag 8 + u128 payload', () => {
    const buf = encodeStakeAdminSetMaintenanceFee(77n);
    expect(buf[0]).toBe(8);
    expect(buf.length).toBe(1 + 16);
    const lo = buf.readBigUInt64LE(1);
    const hi = buf.readBigUInt64LE(9);
    expect(lo + (hi << 64n)).toBe(77n);
  });

  it('encodeStakeAdminResolveMarket — tag 9, 1 byte', () => {
    const buf = encodeStakeAdminResolveMarket();
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(9);
  });

  it('encodeStakeAdminWithdrawInsurance — tag 10 + amount', () => {
    const buf = encodeStakeAdminWithdrawInsurance(1234n);
    expect(buf[0]).toBe(10);
    expect(buf.readBigUInt64LE(1)).toBe(1234n);
  });

  it('encodeStakeAdminSetInsurancePolicy — tag 11 + pubkey + u64 + u16 + u64', () => {
    const auth = Keypair.generate().publicKey;
    const buf = encodeStakeAdminSetInsurancePolicy(auth, 100n, 500, 200n);
    expect(buf[0]).toBe(11);
    expect(buf.length).toBe(1 + 32 + 8 + 2 + 8);
    expect(new PublicKey(buf.subarray(1, 33)).equals(auth)).toBe(true);
    expect(buf.readBigUInt64LE(33)).toBe(100n);
    expect(buf.readUInt16LE(41)).toBe(500);
    expect(buf.readBigUInt64LE(43)).toBe(200n);
  });

  it('encodeStakeDeposit accepts number', () => {
    const buf = encodeStakeDeposit(42);
    expect(buf.readBigUInt64LE(1)).toBe(42n);
  });

  it('encodeStakeInitPool with max u64', () => {
    const max = BigInt('18446744073709551615');
    const buf = encodeStakeInitPool(max, max);
    expect(buf.readBigUInt64LE(1)).toBe(max);
    expect(buf.readBigUInt64LE(9)).toBe(max);
  });
});

describe('Account builders', () => {
  const admin = Keypair.generate().publicKey;
  const percolatorProgram = new PublicKey('GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24');

  it('initPoolAccounts returns 11 accounts in correct order', () => {
    const [pool] = deriveStakePool(slab);
    const [vaultAuth] = deriveStakeVaultAuth(pool);
    const lpMint = Keypair.generate().publicKey;
    const vault = Keypair.generate().publicKey;
    const collateralMint = Keypair.generate().publicKey;

    const accounts = initPoolAccounts({
      admin, slab, pool, lpMint, vault, vaultAuth, collateralMint, percolatorProgram,
    });

    expect(accounts).toHaveLength(11);
    expect(accounts[0].pubkey.equals(admin)).toBe(true);
    expect(accounts[0].isSigner).toBe(true);
    expect(accounts[0].isWritable).toBe(true);
    expect(accounts[1].pubkey.equals(slab)).toBe(true);
    expect(accounts[2].pubkey.equals(pool)).toBe(true);
    expect(accounts[2].isWritable).toBe(true);
  });

  it('depositAccounts returns 11 accounts', () => {
    const [pool] = deriveStakePool(slab);
    const [vaultAuth] = deriveStakeVaultAuth(pool);
    const [depositPda] = deriveDepositPda(pool, user);

    const accounts = depositAccounts({
      user,
      pool,
      userCollateralAta: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      lpMint: Keypair.generate().publicKey,
      userLpAta: Keypair.generate().publicKey,
      vaultAuth,
      depositPda,
    });

    expect(accounts).toHaveLength(11);
    expect(accounts[0].pubkey.equals(user)).toBe(true);
    expect(accounts[0].isSigner).toBe(true);
  });

  it('withdrawAccounts returns 10 accounts', () => {
    const [pool] = deriveStakePool(slab);
    const [vaultAuth] = deriveStakeVaultAuth(pool);
    const [depositPda] = deriveDepositPda(pool, user);

    const accounts = withdrawAccounts({
      user,
      pool,
      userLpAta: Keypair.generate().publicKey,
      lpMint: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      userCollateralAta: Keypair.generate().publicKey,
      vaultAuth,
      depositPda,
    });

    expect(accounts).toHaveLength(10);
    expect(accounts[0].isSigner).toBe(true);
  });

  it('flushToInsuranceAccounts returns 8 accounts', () => {
    const [pool] = deriveStakePool(slab);
    const [vaultAuth] = deriveStakeVaultAuth(pool);

    const accounts = flushToInsuranceAccounts({
      caller: admin,
      pool,
      vault: Keypair.generate().publicKey,
      vaultAuth,
      slab,
      wrapperVault: Keypair.generate().publicKey,
      percolatorProgram,
    });

    expect(accounts).toHaveLength(8);
    expect(accounts[4].pubkey.equals(slab)).toBe(true);
    expect(accounts[4].isWritable).toBe(true);
  });
});
