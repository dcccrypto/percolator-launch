/**
 * Branch coverage for hooks/useStakePool.ts: empty / uninitialised / short pool
 * accounts, missing or throwing mint + vault reads, disconnected wallet,
 * deposit-PDA edge cases, cooldown logic, zero-supply maths, outer error path,
 * stale-request bail-outs and decodeStakePoolV1 length floor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

const {
  mockPool, mockVaultAuth, mockDepositPda, mockLpMint, mockVault,
  mockLpAta, mockCollateralAta, ctl,
} = vi.hoisted(() => {
  const { Keypair: Kp } = require('@solana/web3.js');
  return {
    mockPool: Kp.generate().publicKey,
    mockVaultAuth: Kp.generate().publicKey,
    mockDepositPda: Kp.generate().publicKey,
    mockLpMint: Kp.generate().publicKey,
    mockVault: Kp.generate().publicKey,
    mockLpAta: Kp.generate().publicKey,
    mockCollateralAta: Kp.generate().publicKey,
    ctl: { supply: 10_000_000n, vaultAmt: 5_000_000n, lpAmt: 2_000_000n },
  };
});

vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));
vi.mock('@/components/providers/SlabProvider', () => ({ useSlabState: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: vi.fn() }));

vi.mock('@percolatorct/sdk', () => ({
  deriveStakePool: vi.fn().mockReturnValue([mockPool, 255]),
  deriveStakeVaultAuth: vi.fn().mockReturnValue([mockVaultAuth, 254]),
  deriveDepositPda: vi.fn().mockReturnValue([mockDepositPda, 253]),
}));

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn(async (mint: PublicKey) =>
    mint.equals(mockLpMint) ? mockLpAta : mockCollateralAta),
  unpackMint: vi.fn(() => ({ supply: ctl.supply })),
  unpackAccount: vi.fn((pubkey: PublicKey) => {
    if (pubkey.equals(mockCollateralAta)) return { amount: 7_000_000n };
    if (pubkey.equals(mockLpAta)) return { amount: ctl.lpAmt };
    return { amount: ctl.vaultAmt };
  }),
}));

import { useStakePool, decodeStakePoolV1, STAKE_POOL_SIZE_V1 } from '../../hooks/useStakePool';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

const wallet = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const slab = Keypair.generate().publicKey.toBase58();
const collMint = new PublicKey('So11111111111111111111111111111111111111112');

function poolData(opts: { init?: boolean; cooldown?: bigint; cap?: bigint; len?: number } = {}): Buffer {
  const buf = Buffer.alloc(opts.len ?? 408);
  buf[0] = opts.init === false ? 0 : 1;
  mockLpMint.toBuffer().copy(buf, 104);
  mockVault.toBuffer().copy(buf, 136);
  buf.writeBigUInt64LE(opts.cooldown ?? 0n, 184);
  buf.writeBigUInt64LE(opts.cap ?? 0n, 192);
  return buf;
}

function depositData(opts: { init?: boolean; slot?: bigint; len?: number } = {}): Buffer {
  const buf = Buffer.alloc(opts.len ?? 152);
  buf[0] = opts.init === false ? 0 : 1;
  buf.writeBigUInt64LE(opts.slot ?? 50n, 72);
  return buf;
}

type Resp = Record<string, any>;
function setup(over: { pool?: any; deposit?: any; mint?: any; vault?: any; slot?: any; throwOn?: PublicKey[] } = {}) {
  const has = (k: string) => k in over;
  const conn: any = {
    getAccountInfo: vi.fn(async (pk: PublicKey) => {
      if (over.throwOn?.some((t) => t.equals(pk))) throw new Error('rpc down');
      const r = (v: any, d: any) => (typeof v === 'function' ? v() : v === undefined ? d : v);
      if (pk.equals(mockPool)) return r(has('pool') ? over.pool : undefined, { data: poolData() });
      if (pk.equals(mockDepositPda)) return r(has('deposit') ? over.deposit : undefined, null);
      if (pk.equals(mockLpMint)) return r(has('mint') ? over.mint : undefined, { data: Buffer.alloc(82) });
      if (pk.equals(mockVault)) return r(has('vault') ? over.vault : undefined, { data: Buffer.alloc(165) });
      return { data: Buffer.alloc(165) };
    }),
    getSlot: has('slot') ? over.slot : vi.fn().mockResolvedValue(1000),
  };
  vi.mocked(useConnectionCompat).mockReturnValue({ connection: conn } as any);
  return conn;
}

describe('useStakePool — branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctl.supply = 10_000_000n;
    ctl.vaultAmt = 5_000_000n;
    ctl.lpAmt = 2_000_000n;
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet } as any);
    vi.mocked(useSlabState).mockReturnValue({ config: { collateralMint: collMint } } as any);
    vi.mocked(useParams).mockReturnValue({ slab } as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function settled(r: any) {
    await waitFor(() => expect(r.current.loading).toBe(false));
  }

  describe('pre-fetch guards', () => {
    it('no slab address → pdas null and loading clears without fetching', async () => {
      const conn = setup();
      vi.mocked(useParams).mockReturnValue({} as any);
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.pdas).toBeNull();
      expect(conn.getAccountInfo).not.toHaveBeenCalled();
    });

    it('null params object is tolerated', async () => {
      setup();
      vi.mocked(useParams).mockReturnValue(null as any);
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.pdas).toBeNull();
    });

    it('invalid slab address → pdas null (derive catch)', async () => {
      setup();
      vi.mocked(useParams).mockReturnValue({ slab: 'not-a-pubkey' } as any);
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.pdas).toBeNull();
    });

    it('no connection → loading clears, state stays default', async () => {
      vi.mocked(useConnectionCompat).mockReturnValue({ connection: null } as any);
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.state.poolExists).toBe(false);
    });

    it('disconnected wallet → depositPda null, balances zero', async () => {
      setup();
      vi.mocked(useWalletCompat).mockReturnValue({ publicKey: null } as any);
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.pdas?.depositPda).toBeNull();
      expect(result.current.state.depositPdaAddress).toBeNull();
      expect(result.current.state.userLpBalance).toBe(0n);
      expect(result.current.state.userCollateralBalance).toBe(0n);
    });

    it('connected wallet but slab config not loaded → user balances stay 0, no deposit read', async () => {
      const conn = setup();
      vi.mocked(useSlabState).mockReturnValue({ config: null } as any);
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userLpBalance).toBe(0n);
      expect(conn.getAccountInfo).not.toHaveBeenCalledWith(mockDepositPda);
    });
  });

  describe('pool account states', () => {
    it('missing pool account → default state with PDAs', async () => {
      setup({ pool: null });
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.state.poolExists).toBe(false);
      expect(result.current.state.poolAddress?.equals(mockPool)).toBe(true);
      expect(result.current.state.vaultAuthAddress?.equals(mockVaultAuth)).toBe(true);
    });

    it('empty pool data → default state', async () => {
      setup({ pool: { data: Buffer.alloc(0) } });
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.state.poolExists).toBe(false);
      expect(result.current.state.poolAddress).not.toBeNull();
    });

    it('pool data shorter than the 352 floor → default state (decode throws)', async () => {
      setup({ pool: { data: Buffer.alloc(100) } });
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.state.poolExists).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('uninitialised pool (flag 0) → default state', async () => {
      setup({ pool: { data: poolData({ init: false }) } });
      const { result } = renderHook(() => useStakePool());
      await settled(result);
      expect(result.current.state.poolExists).toBe(false);
    });

    it('exactly 352-byte (retired layout) pool is accepted', async () => {
      setup({ pool: { data: poolData({ len: STAKE_POOL_SIZE_V1, cap: 9n }) } });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.depositCap).toBe(9n);
    });
  });

  describe('mint / vault reads', () => {
    it('missing LP mint and vault → supply/vault 0, rate defaults to 1e6, share 0', async () => {
      setup({ mint: null, vault: null });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      const s = result.current.state;
      expect(s.lpSupply).toBe(0n);
      expect(s.vaultBalance).toBe(0n);
      expect(s.redemptionRateE6).toBe(1_000_000n);
      expect(s.userSharePct).toBe(0);
      expect(s.userRedeemableValue).toBe(0n);
    });

    it('throwing mint and vault reads are swallowed', async () => {
      setup({ throwOn: [mockLpMint, mockVault] });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.lpSupply).toBe(0n);
      expect(result.current.state.vaultBalance).toBe(0n);
      expect(result.current.error).toBeNull();
    });

    it('computes rate, share % and redeemable from supply/vault/LP', async () => {
      ctl.supply = 10_000_000n; ctl.vaultAmt = 15_000_000n; ctl.lpAmt = 2_500_000n;
      setup();
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      const s = result.current.state;
      expect(s.redemptionRateE6).toBe(1_500_000n);
      expect(s.userSharePct).toBe(25);
      expect(s.userRedeemableValue).toBe(3_750_000n);
    });

    it('floors tiny shares (decimal edge: 1 of 3 LP → 33.33%)', async () => {
      ctl.supply = 3n; ctl.vaultAmt = 10n; ctl.lpAmt = 1n;
      setup();
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userSharePct).toBe(33.33);
      expect(result.current.state.userRedeemableValue).toBe(3n); // 10/3 floored
      expect(result.current.state.redemptionRateE6).toBe(3_333_333n);
    });

    it('large u64-scale amounts stay exact in bigint maths', async () => {
      ctl.supply = 2n ** 63n; ctl.vaultAmt = 2n ** 62n; ctl.lpAmt = 2n ** 62n;
      setup();
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.redemptionRateE6).toBe(500_000n);
      expect(result.current.state.userSharePct).toBe(50);
    });
  });

  describe('user ATA reads', () => {
    it('absent LP and collateral ATAs report zero', async () => {
      const conn = setup();
      const orig = conn.getAccountInfo.getMockImplementation()!;
      conn.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
        pk.equals(mockLpAta) || pk.equals(mockCollateralAta) ? null : orig(pk));
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userLpBalance).toBe(0n);
      expect(result.current.state.userCollateralBalance).toBe(0n);
    });

    it('first-ever failed reads (nothing to carry) report zero, not an error', async () => {
      setup({ throwOn: [mockLpAta, mockCollateralAta] });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userLpBalance).toBe(0n);
      expect(result.current.state.userCollateralBalance).toBe(0n);
      expect(result.current.error).toBeNull();
    });
  });

  describe('deposit PDA + cooldown', () => {
    it('no deposit account → slot 0, cooldown elapsed, getSlot unused', async () => {
      const conn = setup({ deposit: null });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userDepositSlot).toBe(0n);
      expect(result.current.state.cooldownElapsed).toBe(true);
      expect(conn.getSlot).not.toHaveBeenCalled();
    });

    it('too-short deposit data is ignored', async () => {
      setup({ deposit: { data: Buffer.alloc(40) } });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userDepositSlot).toBe(0n);
    });

    it('uninitialised deposit data is ignored', async () => {
      setup({ deposit: { data: depositData({ init: false }) } });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userDepositSlot).toBe(0n);
    });

    it('throwing deposit read is swallowed', async () => {
      setup({ throwOn: [mockDepositPda] });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userDepositSlot).toBe(0n);
      expect(result.current.error).toBeNull();
    });

    it('deposit with cooldown 0 → elapsed without querying the slot', async () => {
      const conn = setup({ deposit: { data: depositData({ slot: 50n }) } });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.userDepositSlot).toBe(50n);
      expect(result.current.state.cooldownElapsed).toBe(true);
      expect(conn.getSlot).not.toHaveBeenCalled();
    });

    it('cooldown still running → cooldownElapsed false', async () => {
      setup({
        pool: { data: poolData({ cooldown: 100n }) },
        deposit: { data: depositData({ slot: 950n }) },
      });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.cooldownSlots).toBe(100n);
      expect(result.current.state.cooldownElapsed).toBe(false);
    });

    it('cooldown boundary (slot == deposit + cooldown) → elapsed', async () => {
      setup({
        pool: { data: poolData({ cooldown: 100n }) },
        deposit: { data: depositData({ slot: 900n }) },
      });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.cooldownElapsed).toBe(true);
    });

    it('getSlot failure → conservative cooldownElapsed false', async () => {
      setup({
        pool: { data: poolData({ cooldown: 100n }) },
        deposit: { data: depositData({ slot: 50n }) },
        slot: vi.fn().mockRejectedValue(new Error('slot fail')),
      });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.cooldownElapsed).toBe(false);
    });
  });

  describe('error + staleness', () => {
    it('pool fetch rejection → error surfaced, loading cleared', async () => {
      setup({ throwOn: [mockPool] });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.error).toBeTruthy());
      expect(result.current.loading).toBe(false);
      expect(result.current.state.poolExists).toBe(false);
    });

    it('a superseded refresh at the pool fetch does not publish or clear loading', async () => {
      const conn = setup();
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));

      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const first = conn.getAccountInfo.getMockImplementation()!;
      conn.getAccountInfo.mockImplementationOnce(async (pk: PublicKey) => {
        await gate;
        return pk.equals(mockPool) ? { data: poolData({ cap: 777n }) } : first(pk);
      });
      let p1!: Promise<void>;
      act(() => { p1 = result.current.refreshState(); });
      await act(async () => { await result.current.refreshState(); });
      await act(async () => { release(); await p1; });
      expect(result.current.state.depositCap).toBe(0n); // newer result wins
    });

    it('a superseded refresh that later rejects does not set error', async () => {
      const conn = setup();
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));

      let fail!: () => void;
      const gate = new Promise<void>((_, rej) => { fail = () => rej(new Error('late')); });
      conn.getAccountInfo.mockImplementationOnce(async () => { await gate; return null; });
      let p1!: Promise<void>;
      act(() => { p1 = result.current.refreshState(); });
      await act(async () => { await result.current.refreshState(); });
      await act(async () => { fail(); await p1; });
      expect(result.current.error).toBeNull();
    });

    it.each([
      ['mint', mockLpMint],
      ['vault', mockVault],
      ['lp ata', mockLpAta],
      ['collateral ata', mockCollateralAta],
      ['deposit pda', mockDepositPda],
    ])('a superseded refresh bails after the %s read', async (_n, target) => {
      const conn = setup({ deposit: { data: depositData() } });
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));

      const base = conn.getAccountInfo.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      conn.getAccountInfo.mockImplementationOnce(base); // pool read for call 1
      conn.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
        if (pk.equals(target)) { await gate; }
        return base(pk);
      });
      let p1!: Promise<void>;
      act(() => { p1 = result.current.refreshState(); });
      // supersede while call 1 is parked on `target`
      conn.getAccountInfo.mockImplementation(base);
      await act(async () => { await result.current.refreshState(); });
      await act(async () => { release(); await p1; });
      expect(result.current.state.poolExists).toBe(true);
      expect(result.current.error).toBeNull();
    });

    it('a superseded refresh bails after the getSlot read', async () => {
      let release!: (n: number) => void;
      const gate = new Promise<number>((r) => { release = r; });
      const conn = setup({
        pool: { data: poolData({ cooldown: 100n }) },
        deposit: { data: depositData({ slot: 50n }) },
        slot: vi.fn(),
      });
      conn.getSlot.mockResolvedValue(1000);
      const { result } = renderHook(() => useStakePool());
      await waitFor(() => expect(result.current.state.poolExists).toBe(true));
      expect(result.current.state.cooldownElapsed).toBe(true);

      conn.getSlot.mockImplementationOnce(() => gate); // parked: would yield "not elapsed"
      let p1!: Promise<void>;
      conn.getSlot.mockClear();
      act(() => { p1 = result.current.refreshState(); });
      await waitFor(() => expect(conn.getSlot).toHaveBeenCalledTimes(1)); // call 1 parked in getSlot
      await act(async () => { await result.current.refreshState(); }); // newer: elapsed
      await act(async () => { release(60); await p1; });
      expect(result.current.state.cooldownElapsed).toBe(true);
    });
  });
});

describe('decodeStakePoolV1', () => {
  it('throws below the 352-byte floor', () => {
    expect(() => decodeStakePoolV1(new Uint8Array(351))).toThrow(/too short: 351 < 352/);
  });

  it('flags an uninitialised account without throwing', () => {
    expect(decodeStakePoolV1(new Uint8Array(352)).isInitialized).toBe(false);
  });

  it('honours a non-zero byteOffset view', () => {
    const backing = new Uint8Array(8 + 408);
    backing[8] = 1;
    const view = backing.subarray(8);
    expect(decodeStakePoolV1(view).isInitialized).toBe(true);
  });
});
