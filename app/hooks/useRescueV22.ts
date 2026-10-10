'use client';

import { useCallback, useRef, useState } from 'react';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { deriveInsuranceLpMint } from '@percolatorct/sdk';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { sendTx } from '@/lib/tx';
import { resolveUserMessage, type UserMessage } from '@/lib/limits/user-message';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import { wrapperRefusal } from '@/lib/v22/refusal';
import type { EarnV22Context } from '@/lib/v22/earn-context';
import { vaultTokenOf } from '@/lib/v22/market-accounts';
import { rescueQuote, rescueView, type RescueReadings } from '@/lib/v22/rescue-ui';
import { COMPUTE_PRESETS_V22, buildRescueDepositIxV22 } from '@/lib/v22/sdk';

const SLIPPAGE_BPS = 50;

/** "Add capital at a discount": readings from the Earn tranche view, a quote per amount, one transaction. */
export function useRescueV22(ctx: EarnV22Context | null) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UserMessage | null>(null);
  const inflight = useRef(false);

  const readings: RescueReadings | null =
    isDevnetV22Enabled() && ctx?.view && ctx.registryShares !== null
      ? { v: ctx.view.senior, par: ctx.view.seniorClaimEff, shares: ctx.registryShares }
      : null;
  const view = rescueView(readings, ctx?.decimals ?? 6, ctx?.decimals ?? 6);

  const quote = useCallback((amount: bigint) => (readings ? rescueQuote(readings, amount, SLIPPAGE_BPS) : null), [readings]);

  const rescue = useCallback(
    async (amount: bigint) => {
      if (!ctx || !readings || !wallet.publicKey || inflight.current) return;
      inflight.current = true;
      setBusy(true);
      setMessage(null);
      try {
        const q = rescueQuote(readings, amount, SLIPPAGE_BPS);
        if (!q || q.refusal || q.minShares === null) throw wrapperRefusal(q?.refusal?.code ?? 114);
        const m = { programId: ctx.programId, market: ctx.market, registryDomain: ctx.registryDomain, lpPortfolio: ctx.lpPortfolio ?? undefined };
        const lpMint = deriveInsuranceLpMint(ctx.programId, ctx.market)[0];
        const lpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, true);
        const src = getAssociatedTokenAddressSync(ctx.collateralMint, wallet.publicKey);
        const ix = buildRescueDepositIxV22(m, wallet.publicKey, lpAta, src, vaultTokenOf(ctx.programId, ctx.market, ctx.collateralMint), amount, q.minShares);
        await sendTx({ connection, wallet, instructions: [createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, lpAta, wallet.publicKey, lpMint), ix], computeUnits: COMPUTE_PRESETS_V22.rescueDeposit.units, simulateBeforeSign: true });
        ctx.onDone?.();
      } catch (e) {
        const m = resolveUserMessage(e, { surface: 'earn-deposit', symbol: ctx.symbol });
        if (!m.quiet) setMessage(m);
      } finally {
        inflight.current = false;
        setBusy(false);
      }
    },
    [connection, wallet, ctx, readings],
  );

  return { view, readings, quote, rescue, busy, message, connected: !!wallet.publicKey };
}
