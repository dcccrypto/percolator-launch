"use client";

/**
 * "Recover to stakers" for a RESOLVED stake-bound market: stake tag 29 RecoverTerminalInsurance (anyone can send it).
 * It moves the market's remaining insurance (wrapper tag 41) into the pool vault, pays the creator's seed share and books the rest for
 * stakers, so Withdraw can pay it out. Accounts and per-mode tails are the stake program's own (percolator-stake 53f5480
 * src/instruction.rs, tag 29: [caller, pool, pool vault, vault_auth, market, wrapper vault, wrapper vault authority, token program,
 * wrapper program] + FIRST_LOSS [insurance units, creator token] / FEE_ONLY [creator token]); built by the vendored
 * buildRecoverTerminalInsuranceIx. Nothing is sent except on the click; the tx is simulated first.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveStakePool, deriveStakeVaultAuth, deriveVaultAuthority } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { decodeStakePoolV5, deriveInsuranceUnitsV22, STAKE_RISK_MODE } from "@/lib/v22/sdk";
import { buildRecoverTerminalInsuranceIx, decodeTerminalInsuranceCapacity } from "@/lib/v22/sdk/records/stake-wind-down";
import { stakeRecoverState, RECOVER_COPY, type StakeRecoverState } from "@/lib/v22/resolved-claims";
import { parseCustomInstructionError } from "@/lib/self-heal";
import { sendTx, simulateForGate } from "@/lib/tx";
import { invalidateWalletBalance } from "@/lib/wallet-balance-invalidation";
import { errorText } from "@/lib/error-text";

export interface RecoverToStakersState {
  /** Null = nothing to show (live market, no v5 pool, unreadable, flag off). */
  view: StakeRecoverState | null;
  busy: boolean;
  error: string | null;
  done: string | null;
  recover: () => Promise<void>;
}

/** Plain line for a refusal of tag 29 (stake 31 NothingToRecover, 30 MarketNotTerminal, wrapper 21 while portfolios are open). */
export function recoverRefusalCopy(code: number | undefined): { line: string; ok: boolean } {
  if (code === 31) return { line: RECOVER_COPY.nothing, ok: true };
  if (code === 21) return { line: RECOVER_COPY.waitingOnPositions, ok: false };
  return { line: RECOVER_COPY.failed, ok: false };
}

export function useRecoverToStakers(slabAddress: string | null): RecoverToStakersState {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [view, setView] = useState<StakeRecoverState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const stakeProgram = useCallback(
    () => new PublicKey((getConfig() as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake),
    [],
  );

  const load = useCallback(async () => {
    if (!isDevnetV22Enabled() || !slabAddress) return null;
    const market = new PublicKey(slabAddress);
    const sp = stakeProgram();
    const [pool] = deriveStakePool(market, sp);
    const [poolInfo, marketInfo] = await Promise.all([connection.getAccountInfo(pool, "confirmed"), connection.getAccountInfo(market, "confirmed")]);
    if (!poolInfo || !poolInfo.owner.equals(sp) || !marketInfo) return null;
    const poolState = decodeStakePoolV5(new Uint8Array(poolInfo.data));
    const cap = decodeTerminalInsuranceCapacity(new Uint8Array(marketInfo.data), 0);
    return { market, sp, pool, poolState, cap, wrapper: marketInfo.owner };
  }, [connection, slabAddress, stakeProgram]);

  useEffect(() => {
    let cancelled = false;
    setDone(null);
    setError(null);
    load()
      .then((r) => {
        if (!cancelled) setView(r ? stakeRecoverState(r.cap) : null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const recover = useCallback(async () => {
    if (!wallet.publicKey) {
      setError(RECOVER_COPY.failed);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await load();
      if (!r) throw new Error("pool not readable");
      const state = stakeRecoverState(r.cap);
      if (!state.offer) return;
      if (state.blockedByPositions) {
        setError(RECOVER_COPY.waitingOnPositions);
        return;
      }
      const [vaultAuth] = deriveStakeVaultAuth(r.pool, r.sp);
      const [wrapperVaultAuthority] = deriveVaultAuthority(r.poolState.percolatorProgram, r.market);
      const riskMode = r.poolState.riskMode as 0 | 1 | 2;
      const creatorToken = riskMode === 0 ? undefined : getAssociatedTokenAddressSync(r.poolState.collateralMint, r.poolState.admin, true);
      const pre: TransactionInstruction[] = creatorToken
        ? [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, creatorToken, r.poolState.admin, r.poolState.collateralMint)]
        : [];
      const ix = buildRecoverTerminalInsuranceIx(
        {
          stakeProgram: r.sp,
          caller: wallet.publicKey,
          pool: r.pool,
          poolVault: r.poolState.vault,
          vaultAuth,
          market: r.market,
          wrapperVault: getAssociatedTokenAddressSync(r.poolState.collateralMint, wrapperVaultAuthority, true),
          wrapperVaultAuthority,
          wrapperProgram: r.poolState.percolatorProgram,
          tokenProgram: TOKEN_PROGRAM_ID,
          riskMode,
          ...(riskMode === STAKE_RISK_MODE.FirstLoss ? { insuranceUnits: deriveInsuranceUnitsV22(r.poolState.percolatorProgram, r.market)[0] } : {}),
          ...(creatorToken ? { creatorToken } : {}),
        },
        state.amount,
      );
      const ixs = [...pre, ix];
      const sim = await simulateForGate(connection, wallet.publicKey, ixs);
      if (sim.err) {
        const c = recoverRefusalCopy(parseCustomInstructionError(sim.err)?.code);
        if (c.ok) setDone(c.line);
        else setError(c.line);
        return;
      }
      await sendTx({ connection, wallet, instructions: ixs, computeUnits: 400_000 });
      invalidateWalletBalance();
      setDone(RECOVER_COPY.done);
      setView(null);
    } catch (e) {
      const msg = errorText(e);
      setError(/reject|declin|cancel/i.test(msg) ? "Cancelled. Nothing was sent." : RECOVER_COPY.failed);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [wallet, connection, load]);

  return { view, busy, error, done, recover };
}
