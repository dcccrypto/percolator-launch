'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useClusterSlot } from '@/hooks/useClusterSlot';
import { sendTx } from '@/lib/tx';
import { resolveUserMessage, type UserMessage } from '@/lib/limits/user-message';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import { wrapperRefusal } from '@/lib/v22/refusal';
import type { EarnV22Context } from '@/lib/v22/earn-context';
import { readBondAccounts, vaultTokenOf, type BondAccounts } from '@/lib/v22/market-accounts';
import { bondCardState, bondDepositQuote, bondWithdrawQuote, type BondReadings } from '@/lib/v22/bond-ui';
import {
  COMPUTE_PRESETS_V22,
  buildBondDepositIxV22,
  buildBondExecuteWithdrawIxV22,
  buildBondRequestWithdrawIxV22,
  type MarketV22,
} from '@/lib/v22/sdk';

const SLIPPAGE_BPS = 50;

/**
 * Bond card data + actions for one market. `bond === null` means the market has no tranche (or the flag is
 * off): the card renders nothing. Reads are one batched RPC every 15 s; the flag off performs no RPC at all.
 */
export function useBondV22(ctx: EarnV22Context | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slot = useClusterSlot();
  const [bond, setBond] = useState<BondAccounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UserMessage | null>(null);
  const inflight = useRef(false);
  const enabled = isDevnetV22Enabled() && ctx !== null;
  const owner = wallet.publicKey ?? null;
  const key = ctx ? `${ctx.market.toBase58()}:${owner?.toBase58() ?? ''}` : '';

  const refresh = useCallback(async () => {
    if (!ctx || !enabled) return;
    try {
      setBond(await readBondAccounts(connection, ctx.programId, ctx.market, owner));
    } catch {
      /* keep the last good read */
    }
  }, [connection, ctx, enabled, owner]);

  useEffect(() => {
    if (!enabled) { setBond(null); return; }
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  const readings: BondReadings | null = ctx?.view
    ? { vaultValue: ctx.view.vaultValue, seniorClaimEff: ctx.view.seniorClaimEff, oiLongQ: ctx.oiLongQ, oiShortQ: ctx.oiShortQ, lpEffAbsQ: ctx.lpEffAbsQ }
    : null;
  const state = bond ? bondCardState({ tranche: bond.tranche, position: bond.position, nowSlot: slot ?? 0n, readings }) : null;

  const market = (): MarketV22 => {
    if (!ctx) throw new Error('no market');
    return { programId: ctx.programId, market: ctx.market, registryDomain: ctx.registryDomain, lpPortfolio: ctx.lpPortfolio ?? undefined };
  };

  const run = useCallback(
    async (build: () => { ix: ReturnType<typeof buildBondDepositIxV22>; units: number }) => {
      if (!ctx || !wallet.publicKey || inflight.current) return;
      inflight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const { ix, units } = build();
        await sendTx({ connection, wallet, instructions: [ix], computeUnits: units, simulateBeforeSign: true });
        await refresh();
        ctx.onDone?.();
      } catch (e) {
        const m = resolveUserMessage(e, { surface: 'earn-deposit', symbol: ctx.symbol });
        if (!m.quiet) setMessage(m);
        // 124: the price moved past the floor; re-read so the next quote (and floor) is fresh.
        if (m.requote) await refresh();
      } finally {
        inflight.current = false;
        setBusy(false);
      }
    },
    [connection, wallet, ctx, refresh],
  );

  const deposit = useCallback(
    (amount: bigint) =>
      run(() => {
        if (!bond || !readings || !wallet.publicKey || !ctx) throw new Error('Not ready');
        const q = bondDepositQuote(bond.tranche, amount, readings, SLIPPAGE_BPS);
        if (!q || q.refusal || q.minShares === null) throw wrapperRefusal(q?.refusal?.code ?? 107);
        const src = getAssociatedTokenAddressSync(ctx.collateralMint, wallet.publicKey);
        const ix = buildBondDepositIxV22(market(), wallet.publicKey, src, vaultTokenOf(ctx.programId, ctx.market, ctx.collateralMint), amount, q.minShares);
        return { ix, units: COMPUTE_PRESETS_V22.bondDeposit.units };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, bond, readings, wallet.publicKey, ctx],
  );

  const requestWithdraw = useCallback(
    (shares: bigint) =>
      run(() => {
        if (!wallet.publicKey || !ctx) throw new Error('Not ready');
        return { ix: buildBondRequestWithdrawIxV22(market(), wallet.publicKey, shares), units: COMPUTE_PRESETS_V22.bondRequestWithdraw.units };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, wallet.publicKey, ctx],
  );

  const executeWithdraw = useCallback(
    () =>
      run(() => {
        if (!bond?.position || !readings || !wallet.publicKey || !ctx) throw new Error('Not ready');
        const q = bondWithdrawQuote(bond.tranche, bond.position, readings, SLIPPAGE_BPS);
        if (!q || q.refusal || q.minOut === null) throw wrapperRefusal(q?.refusal?.code ?? 110);
        const dest = getAssociatedTokenAddressSync(ctx.collateralMint, wallet.publicKey);
        const ix = buildBondExecuteWithdrawIxV22(market(), wallet.publicKey, dest, vaultTokenOf(ctx.programId, ctx.market, ctx.collateralMint), q.minOut, ctx.registryDomain);
        return { ix, units: COMPUTE_PRESETS_V22.bondExecuteWithdraw.units };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, bond, readings, wallet.publicKey, ctx],
  );

  return { bond, state, readings, busy, message, deposit, requestWithdraw, executeWithdraw, refresh, connected: !!owner };
}
