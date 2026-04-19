'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import {
  STAKE_POOL_SIZE,
  deriveStakePool,
  deriveStakeVaultAuth,
  deriveDepositPda,
  decodeStakePool,
} from '@percolatorct/sdk';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import {
  getAssociatedTokenAddress,
  unpackMint,
  unpackAccount,
} from '@solana/spl-token';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface StakePoolState {
  /** Whether the stake pool PDA exists on-chain */
  poolExists: boolean;
  /** Stake pool PDA */
  poolAddress: PublicKey | null;
  /** Vault authority PDA (signs transfers) */
  vaultAuthAddress: PublicKey | null;
  /** User deposit PDA (tracks cooldown) */
  depositPdaAddress: PublicKey | null;
  /** LP mint for this stake pool */
  lpMintAddress: PublicKey | null;
  /** Collateral vault balance (tokens in the stake vault) */
  vaultBalance: bigint;
  /** Total LP supply minted */
  lpSupply: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** User's collateral ATA balance (available to deposit) */
  userCollateralBalance: bigint;
  /** Current redemption rate: vault_balance / lp_supply (scaled to 1e6) */
  redemptionRateE6: bigint;
  /** User's share of the pool as a percentage */
  userSharePct: number;
  /** User's redeemable collateral value */
  userRedeemableValue: bigint;
  /** Cooldown slots from pool config (0 = no cooldown) */
  cooldownSlots: bigint;
  /** Deposit cap from pool config (0 = unlimited) */
  depositCap: bigint;
  /** User's deposit timestamp slot (from deposit PDA, 0 if no deposit) */
  userDepositSlot: bigint;
  /** Whether user's cooldown has elapsed (can withdraw) */
  cooldownElapsed: boolean;
}

const DEFAULT_STATE: StakePoolState = {
  poolExists: false,
  poolAddress: null,
  vaultAuthAddress: null,
  depositPdaAddress: null,
  lpMintAddress: null,
  vaultBalance: 0n,
  lpSupply: 0n,
  userLpBalance: 0n,
  userCollateralBalance: 0n,
  redemptionRateE6: 1_000_000n,
  userSharePct: 0,
  userRedeemableValue: 0n,
  cooldownSlots: 0n,
  depositCap: 0n,
  userDepositSlot: 0n,
  cooldownElapsed: true,
};

// ═══════════════════════════════════════════════════════════════
// DepositPda account layout helper
// ═══════════════════════════════════════════════════════════════

// Browser-safe u64 reader — DataView instead of Buffer.readBigUInt64LE
// (Buffer BigInt methods are Node.js-only; the browser polyfill may lack them)
function readU64LE(data: Uint8Array, off: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(off, /* littleEndian= */ true);
}

/**
 * Parse the on-chain DepositPda (per-user) account.
 * Layout:
 *   - is_initialized: u8       (1 byte)
 *   - bump:           u8       (1 byte)
 *   - padding:        [u8; 6]  (6 bytes)
 *   - pool:           [u8; 32] (32 bytes)
 *   - user:           [u8; 32] (32 bytes)
 *   - deposit_slot:   u64      (8 bytes)
 *   - amount:         u64      (8 bytes)
 * Total: 88 bytes used out of the 152-byte on-chain account.
 */
function parseDepositPdaAccount(data: Buffer) {
  if (data.length < 88) return null;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const isInitialized = bytes[0] === 1;
  if (!isInitialized) return null;

  let offset = 8; // skip is_initialized, bump, and padding
  const pool = new PublicKey(bytes.subarray(offset, offset + 32)); offset += 32;
  const user = new PublicKey(bytes.subarray(offset, offset + 32)); offset += 32;
  const depositSlot = readU64LE(bytes, offset); offset += 8;
  const amount = readU64LE(bytes, offset); offset += 8;

  return { pool, user, depositSlot, amount };
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

/**
 * Read-only hook for stake pool state. Derives PDAs, fetches on-chain data,
 * and returns balances, redemption rate, cooldown status, etc.
 *
 * Auto-refreshes every 10s. Call `refreshState()` for manual refresh.
 */
export function useStakePool() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;

  const [state, setState] = useState<StakePoolState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stabilize wallet ref
  const walletPubkeyStr = wallet.publicKey?.toBase58() ?? null;

  // Derive PDAs
  const pdas = useMemo(() => {
    if (!slabAddress) return null;
    try {
      const slabPk = new PublicKey(slabAddress);
      const [poolPda] = deriveStakePool(slabPk);
      const [vaultAuthPda] = deriveStakeVaultAuth(poolPda);
      let depositPda: PublicKey | null = null;
      if (walletPubkeyStr) {
        const walletPk = new PublicKey(walletPubkeyStr);
        [depositPda] = deriveDepositPda(poolPda, walletPk);
      }
      return { poolPda, vaultAuthPda, depositPda, slabPk };
    } catch {
      return null;
    }
  }, [slabAddress, walletPubkeyStr]);

  const refreshState = useCallback(async () => {
    if (!pdas || !connection) return;

    try {
      // Fetch pool account
      const poolInfo = await connection.getAccountInfo(pdas.poolPda);
      if (!poolInfo || poolInfo.data.length === 0) {
        setState({ ...DEFAULT_STATE, poolAddress: pdas.poolPda, vaultAuthAddress: pdas.vaultAuthPda });
        return;
      }

      // Decode pool using canonical StakePool layout from SDK (352 bytes).
      // Avoids manual byte offset arithmetic — offsets are versioned in decodeStakePool.
      let poolData: ReturnType<typeof decodeStakePool> | null = null;
      try {
        poolData = decodeStakePool(Buffer.from(poolInfo.data));
        if (!poolData.isInitialized) poolData = null;
      } catch {
        poolData = null;
      }
      if (!poolData) {
        setState({ ...DEFAULT_STATE, poolAddress: pdas.poolPda, vaultAuthAddress: pdas.vaultAuthPda });
        return;
      }

      // Fetch LP mint supply
      let lpSupply = 0n;
      try {
        const mintInfo = await connection.getAccountInfo(poolData.lpMint);
        if (mintInfo) {
          const mint = unpackMint(poolData.lpMint, mintInfo);
          lpSupply = mint.supply;
        }
      } catch { /* mint may not exist yet */ }

      // Fetch vault balance (collateral in stake vault)
      let vaultBalance = 0n;
      try {
        const vaultInfo = await connection.getAccountInfo(poolData.vault);
        if (vaultInfo) {
          const vaultAccount = unpackAccount(poolData.vault, vaultInfo);
          vaultBalance = vaultAccount.amount;
        }
      } catch { /* vault may not exist */ }

      // Fetch user balances
      let userLpBalance = 0n;
      let userCollateralBalance = 0n;
      let userDepositSlot = 0n;

      if (walletPubkeyStr && slabState.config) {
        const walletPk = new PublicKey(walletPubkeyStr);
        const collateralMint = slabState.config.collateralMint;

        // User LP ATA
        try {
          const userLpAta = await getAssociatedTokenAddress(poolData.lpMint, walletPk);
          const lpAtaInfo = await connection.getAccountInfo(userLpAta);
          if (lpAtaInfo) {
            const acct = unpackAccount(userLpAta, lpAtaInfo);
            userLpBalance = acct.amount;
          }
        } catch { /* no LP ATA yet */ }

        // User collateral ATA
        try {
          const userCollAta = await getAssociatedTokenAddress(collateralMint, walletPk);
          const collAtaInfo = await connection.getAccountInfo(userCollAta);
          if (collAtaInfo) {
            const acct = unpackAccount(userCollAta, collAtaInfo);
            userCollateralBalance = acct.amount;
          }
        } catch { /* no collateral ATA */ }

        // User deposit PDA (cooldown tracking)
        if (pdas.depositPda) {
          try {
            const depInfo = await connection.getAccountInfo(pdas.depositPda);
            if (depInfo) {
              const depData = parseDepositPdaAccount(Buffer.from(depInfo.data));
              if (depData) {
                userDepositSlot = depData.depositSlot;
              }
            }
          } catch { /* no deposit PDA yet */ }
        }
      }

      // Calculate derived values
      const redemptionRateE6 = lpSupply > 0n
        ? (vaultBalance * 1_000_000n) / lpSupply
        : 1_000_000n;

      const userSharePct = lpSupply > 0n
        ? Number((userLpBalance * 10000n) / lpSupply) / 100
        : 0;

      const userRedeemableValue = lpSupply > 0n
        ? (userLpBalance * vaultBalance) / lpSupply
        : 0n;

      // Cooldown check — compare current slot to deposit slot + cooldown
      let cooldownElapsed = true;
      if (userDepositSlot > 0n && poolData.cooldownSlots > 0n) {
        try {
          const currentSlot = BigInt(await connection.getSlot());
          cooldownElapsed = currentSlot >= userDepositSlot + poolData.cooldownSlots;
        } catch {
          cooldownElapsed = false; // conservative: block withdrawal if we can't check
        }
      }

      setState({
        poolExists: true,
        poolAddress: pdas.poolPda,
        vaultAuthAddress: pdas.vaultAuthPda,
        depositPdaAddress: pdas.depositPda,
        lpMintAddress: poolData.lpMint,
        vaultBalance,
        lpSupply,
        userLpBalance,
        userCollateralBalance,
        redemptionRateE6,
        userSharePct,
        userRedeemableValue,
        cooldownSlots: poolData.cooldownSlots,
        depositCap: poolData.depositCap,
        userDepositSlot,
        cooldownElapsed,
      });
    } catch (err) {
      console.error('[useStakePool] Failed to refresh:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pdas, connection, walletPubkeyStr, slabState.config]);

  // Auto-refresh using ref to avoid stale closure (same pattern as useInsuranceLP)
  const refreshRef = useRef(refreshState);
  useEffect(() => {
    refreshRef.current = refreshState;
  }, [refreshState]);

  useEffect(() => {
    const doRefresh = () => refreshRef.current();
    doRefresh();
    const interval = setInterval(doRefresh, 10_000);
    return () => clearInterval(interval);
  }, []);

  return {
    state,
    loading,
    error,
    refreshState,
    pdas,
  };
}
