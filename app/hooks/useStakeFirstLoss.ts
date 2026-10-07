'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from '@solana/spl-token';
import { deriveDepositPda, deriveStakePool, deriveStakeVaultAuth } from '@percolatorct/sdk';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { DEVNET_PROGRAM_IDS } from '@/lib/program-ids';
import { getConfig } from '@/lib/config';
import { sendTx } from '@/lib/tx';
import { assertDepositWithinBalance, readTokenBalance } from '@/lib/deposit-guard';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import { ConsentChangedError, buildStakeDepositV5Ix, consentKey, consentViewOf, readFirstLossPool, type ConsentView } from '@/lib/v22/stake-v5';
import type { StakePoolV5 } from '@/lib/v22/sdk';

function stakeProgramId(): PublicKey {
  return new PublicKey((getConfig() as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake);
}

/**
 * First-loss stake v5. `pool` is null for any pool that is not a v5 first-loss pool (and always when the flag is
 * off), in which case the existing deposit UI is used untouched. `deposit(amount, accepted)` re-reads the pool right
 * before building and throws {@link ConsentChangedError} when the numbers differ from what the user accepted.
 */
export function useStakeFirstLoss(slabAddress: string, collateralMint: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [pool, setPool] = useState<StakePoolV5 | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const enabled = isDevnetV22Enabled() && !!slabAddress;

  const read = useCallback(async (): Promise<StakePoolV5 | null> => {
    const [poolKey] = deriveStakePool(new PublicKey(slabAddress), stakeProgramId());
    const info = await connection.getAccountInfo(poolKey, 'confirmed');
    if (!info || !info.owner.equals(stakeProgramId())) return null;
    return readFirstLossPool(new Uint8Array(info.data));
  }, [connection, slabAddress]);

  useEffect(() => {
    setPool(null);
    if (!enabled) return;
    let cancelled = false;
    read().then((p) => { if (!cancelled) setPool(p); }).catch(() => { if (!cancelled) setPool(null); });
    return () => { cancelled = true; };
  }, [enabled, read]);

  const deposit = useCallback(
    async (amount: bigint, accepted: ConsentView) => {
      if (inflight.current) throw new Error('Stake deposit already in progress');
      inflight.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !wallet.signTransaction) throw new Error('Wallet not connected');
        if (amount <= 0n) throw new Error('Deposit amount must be greater than zero');
        const fresh = await read();
        if (!fresh) throw new Error('Stake pool not available for this market.');
        const now = consentViewOf(fresh);
        if (consentKey(now) !== consentKey(accepted)) {
          setPool(fresh);
          throw new ConsentChangedError(now);
        }
        const programId = stakeProgramId();
        const slab = new PublicKey(slabAddress);
        const mint = new PublicKey(collateralMint);
        const [poolKey] = deriveStakePool(slab, programId);
        const [vaultAuth] = deriveStakeVaultAuth(poolKey, programId);
        const [depositPda] = deriveDepositPda(poolKey, wallet.publicKey, programId);
        const userCollateral = await getAssociatedTokenAddress(mint, wallet.publicKey);
        assertDepositWithinBalance(amount, await readTokenBalance(connection, userCollateral));
        const userLp = await getAssociatedTokenAddress(fresh.lpMint, wallet.publicKey);
        const ixs: TransactionInstruction[] = [];
        if (!(await connection.getAccountInfo(userLp))) ixs.push(createAssociatedTokenAccountInstruction(wallet.publicKey, userLp, wallet.publicKey, fresh.lpMint));
        ixs.push(buildStakeDepositV5Ix({ stakeProgramId: programId, pool: poolKey, poolState: fresh, user: wallet.publicKey, userCollateral, userLp, vaultAuthority: vaultAuth, depositPda, amount }));
        return await sendTx({ connection, wallet, instructions: ixs, simulateBeforeSign: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        inflight.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, read, slabAddress, collateralMint],
  );

  return { pool, deposit, loading, error };
}
