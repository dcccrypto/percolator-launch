'use client';

/**
 * Capacity bond: a compact card on the Earn rail, only for markets that have a bond tranche. Honest copy,
 * no mechanics: losses come after the creator's first-loss stake and before Earn, the coupon comes from
 * fees and is capped, and a live exit needs the market's liquidity to be flat.
 */
import { useState } from 'react';
import { StatusLine } from '@/components/ui/StatusLine';
import { useBondV22 } from '@/hooks/useBondV22';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import type { EarnV22Context } from '@/lib/v22/earn-context';
import { V22_COPY, fmtTokens } from '@/lib/v22/copy';
import { bondDepositQuote, slotsToWait } from '@/lib/v22/bond-ui';
import { parseHumanAmount } from '@/lib/parseAmount';

const toHuman = (a: bigint, d: number) => fmtTokens(Number(a) / 10 ** d);

export function BondCard({ ctx }: { ctx: EarnV22Context | null }) {
  if (!isDevnetV22Enabled() || !ctx) return null;
  return <BondCardInner ctx={ctx} />;
}

function BondCardInner({ ctx }: { ctx: EarnV22Context }) {
  const b = useBondV22(ctx);
  const [amount, setAmount] = useState('');
  if (!b.bond || !b.state) return null;
  const { tranche, position } = b.bond;
  const s = b.state;
  let atoms: bigint | null = null;
  try { atoms = amount ? parseHumanAmount(amount, ctx.decimals) : null; } catch { atoms = null; }
  const q = atoms && b.readings ? bondDepositQuote(tranche, atoms, b.readings) : null;
  const refused = q?.refusal ?? null;
  const pending = position?.pendingWithdrawShares ?? 0n;

  return (
    <div data-testid="bond-card" className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
      <h3 className="mb-1 text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>{V22_COPY.bond.title}</h3>
      <ul className="mb-3 space-y-1 text-[11px] text-[var(--text-secondary)]">
        <li data-testid="bond-absorbs">{V22_COPY.bond.absorbs}</li>
        <li data-testid="bond-coupon">{V22_COPY.bond.coupon} Up to {s.couponCapPctYear}% a year.</li>
        <li data-testid="bond-exit">{V22_COPY.bond.exit}</li>
      </ul>

      {position && position.shares > 0n && (
        <p data-testid="bond-position" className="mb-3 text-[12px] tabular-nums text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
          Your bond: {toHuman(position.shares, ctx.decimals)} shares
        </p>
      )}

      {s.impaired && <StatusLine message={{ kind: 'bond-impaired', variant: 'paused', title: 'Deposits paused', body: V22_COPY.bond.impaired }} className="mb-3" />}

      <div className="flex gap-2">
        <input
          data-testid="bond-amount"
          type="number" min="0" step="any" value={amount} placeholder="0.00"
          onChange={(e) => setAmount(e.target.value)}
          disabled={!s.canDeposit || b.busy}
          className="flex-1 border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] tabular-nums text-[var(--text)] outline-none"
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <button
          type="button" data-testid="bond-deposit"
          disabled={!b.connected || !s.canDeposit || !atoms || !q || !!refused || b.busy}
          onClick={() => atoms && void b.deposit(atoms).then(() => setAmount(''))}
          className="border border-[var(--accent)]/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-text)] disabled:opacity-40"
        >
          {V22_COPY.bond.deposit}
        </button>
      </div>
      {q?.minShares != null && !refused && (
        <p data-testid="bond-quote" className="mt-1 text-[11px] text-[var(--text-muted)]">You'll receive at least {toHuman(q.minShares, ctx.decimals)} shares.</p>
      )}
      {refused?.code === 123 && <p className="mt-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.bond.full}</p>}

      {position && position.shares > 0n && (
        <div className="mt-3 border-t border-[var(--border)]/60 pt-3">
          {s.cooldown === 'none' && (
            <>
              <button
                type="button" data-testid="bond-request" disabled={!s.canRequestWithdraw || b.busy}
                onClick={() => void b.requestWithdraw(position.shares - position.pendingWithdrawShares)}
                className="border border-[var(--border)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)] disabled:opacity-40"
              >
                {V22_COPY.bond.requestWithdraw}
              </button>
              {s.flat === false && <p data-testid="bond-locked" className="mt-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.bond.locked}</p>}
            </>
          )}
          {s.cooldown === 'pending' && <p data-testid="bond-cooldown" className="text-[11px] text-[var(--text-secondary)]">{V22_COPY.bond.cooldown(slotsToWait(s.slotsLeft))}</p>}
          {s.cooldown === 'ready' && (
            <>
              <p data-testid="bond-ready" className="mb-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.bond.cooldownReady} {toHuman(pending, ctx.decimals)} shares.</p>
              <button
                type="button" data-testid="bond-execute" disabled={!s.canExecuteWithdraw || s.flat !== true || b.busy}
                onClick={() => void b.executeWithdraw()}
                className="border border-[var(--accent)]/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-text)] disabled:opacity-40"
              >
                {V22_COPY.bond.executeWithdraw}
              </button>
              {s.flat !== true && <p data-testid="bond-locked" className="mt-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.bond.locked}</p>}
            </>
          )}
        </div>
      )}

      {b.message && <StatusLine message={b.message} className="mt-3" />}
    </div>
  );
}
