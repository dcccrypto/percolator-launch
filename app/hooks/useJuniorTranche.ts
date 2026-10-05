'use client';

/**
 * Creator's junior (first-loss) tranche on a P3 vault-owned-LP market: top up (96) and withdraw
 * (97). Only the junior owner (the creator who ran InitVaultLp path A, or the owner the
 * protocol named on path B) can sign either; 97 is allowed only while the vault LP is FLAT and
 * above `junior_floor_bps` of the senior claim (the panel shows `withdrawable now`). Builders
 * are lib/limits/p3-ix.ts (executed on real BPF in scripts/limits-parity/p3-sim).
 */
import { isDevnetV21Enabled } from '@/lib/v21/flag';
import { assertV1AllowsNewFunds } from '@/lib/v21/move/close-only';
import { deriveVaultLpExt } from '@/lib/v21/sdk';
import { useCallback, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { deriveLpBackingLedger, deriveVaultAuthority } from '@percolatorct/sdk';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { sendTx, SimulationRefusal } from '@/lib/tx';
import { WRAPPER_ERR } from '@/lib/wrapper-errors';
import { keepAppMessage, plainMessage } from '@/lib/limits/user-message';
import { assertDepositWithinBalance, readTokenBalance } from '@/lib/deposit-guard';
import { decodeLpVaultRegistryDomain, decodeVaultLpState } from '@/lib/limits/decode';
import { buildJuniorResolvedReleaseIxs, juniorReleaseNeedsHarvest } from '@/lib/limits/junior-resolved-release';
import { readEmptyCloseIxs } from '@/lib/limits/resolved-exit-load';
import { sendWithTopup } from '@/lib/limits/resolved-topup';
import { computeBudgetPrefix, connectionSelfHealDeps } from '@/lib/self-heal';

/** One empty-portfolio close simulated alone (a resolved ClosePortfolio measured 126k on BPF). */
export const EMPTY_CLOSE_SIM_CU = 300_000;
/** The bundled closes + 102 (+ 78) tx is sized from its own simulation, up to this cap. */
export const EMPTY_CLOSE_BUNDLE_CU_CAP = 1_200_000;
import {
  buildDepositJuniorTrancheIx,
  buildWithdrawJuniorTrancheIx,
  deriveLpVaultRegistryPda,
  deriveVaultLpState,
  type VaultLpMarket,
} from '@/lib/limits/p3-ix';

export function useJuniorTranche(slabAddress: string | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { programId, config } = useSlabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** UX WP-9: the last withdraw was refused 75 in simulation (the wallet never opened). */
  const [refused75, setRefused75] = useState(false);

  const context = useCallback(async () => {
    if (!wallet.publicKey || !slabAddress || !programId || !config) throw new Error('Wallet not connected');
    const prog = new PublicKey(programId);
    const market = new PublicKey(slabAddress);
    const registry = deriveLpVaultRegistryPda(prog, market);
    const vaultLpState = deriveVaultLpState(prog, market);
    // Devnet v2.1: the P2b ext (97 takes it at [11] once it exists) rides in the same batched read.
    const extKey = isDevnetV21Enabled() ? deriveVaultLpExt(prog, market) : null;
    const [ri, si, mi, xi] = await connection.getMultipleAccountsInfo(extKey ? [registry, vaultLpState, market, extKey] : [registry, vaultLpState, market], 'confirmed');
    const st = si && si.owner.equals(prog) ? decodeVaultLpState(new Uint8Array(si.data)) : null;
    if (!st) throw new Error("This market has no vault-owned LP.");
    if (!new PublicKey(st.juniorOwner).equals(wallet.publicKey)) throw new Error('Only the junior owner can move the junior tranche.');
    const domain = ri && ri.owner.equals(prog) ? decodeLpVaultRegistryDomain(new Uint8Array(ri.data)) ?? 0 : 0;
    const vm: VaultLpMarket = {
      programId: prog,
      market,
      registry,
      vaultLpState,
      lpPortfolio: new PublicKey(st.lpPortfolio),
      ledger: deriveLpBackingLedger(prog, market, domain)[0],
      siblingLedger: deriveLpBackingLedger(prog, market, domain ^ 1)[0],
      ...(extKey && xi && xi.owner.equals(prog) ? { ext: extKey } : {}),
    };
    const [vaultAuthority] = deriveVaultAuthority(prog, market);
    const mint = config.collateralMint;
    return {
      vm,
      domain,
      marketData: mi ? new Uint8Array(mi.data) : null,
      owner: wallet.publicKey,
      mint,
      ownerAta: getAssociatedTokenAddressSync(mint, wallet.publicKey),
      vaultToken: getAssociatedTokenAddressSync(mint, vaultAuthority, true),
      vaultAuthority,
    };
  }, [connection, wallet.publicKey, slabAddress, programId, config]);

  const run = useCallback(
    async (kind: 'deposit' | 'withdraw', amount: bigint): Promise<string> => {
      setBusy(true);
      setError(null);
      setRefused75(false);
      try {
        if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
        if (kind === 'deposit') assertV1AllowsNewFunds(programId, 'earn-deposit');
        const c = await context();
        const ixs =
          kind === 'deposit'
            ? (assertDepositWithinBalance(amount, await readTokenBalance(connection, c.ownerAta)),
              [buildDepositJuniorTrancheIx(c.vm, c.owner, c.ownerAta, c.vaultToken, amount)])
            : [
                createAssociatedTokenAccountIdempotentInstruction(c.owner, c.ownerAta, c.owner, c.mint),
                buildWithdrawJuniorTrancheIx(c.vm, c.owner, c.ownerAta, c.vaultToken, c.vaultAuthority, amount),
              ];
        return await sendTx({ connection, wallet, instructions: ixs });
      } catch (e) {
        if (isJuniorWithdrawRefusal(e)) setRefused75(true);
        // UX WP-1 (JR-2): the one resolver, never the raw "custom program error: 0x4b".
        setError(plainMessage(e, { surface: 'creator-stake' }, keepAppMessage));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [connection, wallet, context],
  );

  /**
   * RESOLVED market (next P3 FINAL, F-14): the junior's only terminal exit, tag 102 with the
   * resolved tail, paying up to `physical - C` (Earn seniors keep their claim). 78 goes first in
   * the same tx when fees or a claim-free residual are still pending.
   */
  const releaseResolved = useCallback(
    async (amount: bigint): Promise<string> => {
      setBusy(true);
      setError(null);
      try {
        if (amount <= 0n) throw new Error('Enter an amount greater than zero.');
        const c = await context();
        const ixs = buildJuniorResolvedReleaseIxs(c, amount, juniorReleaseNeedsHarvest(c.marketData, c.domain));
        // 102 is refused 21 while any EMPTY portfolio is still materialized on the Resolved market:
        // the permissionless tag-8 closes go first in the same tx (sim-gated; dropped if they
        // would make it fail), so the junior never waits on the keeper.
        const closes = await readEmptyCloseIxs({
          connection,
          programId: c.vm.programId,
          market: c.vm.market,
          collateralMint: c.mint,
          payer: c.owner,
          simulate: async (x) =>
            (await connectionSelfHealDeps(connection, c.vm.market, c.owner).simulate([...computeBudgetPrefix(EMPTY_CLOSE_SIM_CU), ...x])).err ?? null,
        });
        return await sendWithTopup({
          topup: closes,
          base: ixs,
          isPreSignRefusal: (e) => e instanceof SimulationRefusal,
          packet: { feePayer: c.owner, droppable: closes.length },
          send: (instructions, bundled) =>
            sendTx({ connection, wallet, instructions, ...(bundled ? { computeUnitsFromSim: { cap: EMPTY_CLOSE_BUNDLE_CU_CAP } } : {}) }),
        });
      } catch (e) {
        // UX WP-1 (JR-2): the one resolver, never the raw "custom program error: 0x4b".
        setError(plainMessage(e, { surface: 'creator-stake' }, keepAppMessage));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [connection, wallet, context],
  );

  return {
    busy,
    error,
    refused75,
    deposit: (amount: bigint) => run('deposit', amount),
    withdraw: (amount: bigint) => run('withdraw', amount),
    releaseResolved,
  };
}

/** A pre-sign simulation refusal with 75 VaultLpJuniorWithdrawRefused (the wallet was not opened). */
export function isJuniorWithdrawRefusal(e: unknown): boolean {
  return e instanceof SimulationRefusal && e.code === WRAPPER_ERR.VaultLpJuniorWithdrawRefused;
}
