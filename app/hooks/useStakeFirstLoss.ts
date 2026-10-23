'use client';

import { firstLossStakeErrorMessage } from "@/lib/earnErrors";
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
 * Where the pool read stands. "idle": flag off or no market (no RPC). "loading": in flight, including the automatic
 * retries. "ready": a v5 first-loss pool. "none": read, and not a v5 first-loss pool. "failed": every try failed.
 */
export type FirstLossReadStatus = 'idle' | 'loading' | 'ready' | 'none' | 'failed';

/**
 * #3607: waits before the automatic re-reads of a failed pool read (a devnet 429 or timeout). After the last one the
 * status is "failed" and the page offers `retry()`.
 */
export const FIRST_LOSS_READ_RETRY_MS: readonly number[] = [1_000, 2_000];

/**
 * First-loss stake v5. `pool` is null for any pool that is not a v5 first-loss pool (and always when the flag is
 * off), in which case the existing deposit UI is used untouched. `status` says whether that null means "not
 * first-loss" ("none") or "not known yet" ("loading" / "failed"): a page that already knows the pool is first-loss
 * must not fall back to the plain form on the latter (#3607). `deposit(amount, accepted)` re-reads the pool right
 * before building and throws {@link ConsentChangedError} when the numbers differ from what the user accepted.
 */
export function useStakeFirstLoss(slabAddress: string, collateralMint: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [pool, setPool] = useState<StakePoolV5 | null>(null);
  const [status, setStatus] = useState<FirstLossReadStatus>('idle');
  const [readAttempt, setReadAttempt] = useState(0);
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
    if (!enabled) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      read()
        .then((p) => {
          if (cancelled) return;
          setPool(p);
          setStatus(p ? 'ready' : 'none');
        })
        .catch(() => {
          if (cancelled) return;
          const wait = FIRST_LOSS_READ_RETRY_MS[n];
          if (wait === undefined) {
            setStatus('failed');
            return;
          }
          timer = setTimeout(() => attempt(n + 1), wait);
        });
    };
    attempt(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, read, readAttempt]);

  /** Read the pool again (the page's Retry after "failed" / "none"). */
  const retry = useCallback(() => setReadAttempt((n) => n + 1), []);

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
        setError(firstLossStakeErrorMessage(e)); // #3608: never raw simulation, log or RPC text
        throw e;
      } finally {
        inflight.current = false;
        setLoading(false);
      }
    },
    [connection, wallet, read, slabAddress, collateralMint],
  );

  return { pool, status, retry, deposit, loading, error };
}
