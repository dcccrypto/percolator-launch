'use client';

/** "Add capital at a discount": only on an impaired Earn vault. Price and the slippage floor are shown before signing. */
import { useState } from 'react';
import { StatusLine } from '@/components/ui/StatusLine';
import { useRescueV22 } from '@/hooks/useRescueV22';
import { isDevnetV22Enabled } from '@/lib/v22/flag';
import type { EarnV22Context } from '@/lib/v22/earn-context';
import { V22_COPY, fmtTokens } from '@/lib/v22/copy';
import { parseHumanAmount } from '@/lib/parseAmount';

export function RescueAction({ ctx }: { ctx: EarnV22Context | null }) {
  if (!isDevnetV22Enabled() || !ctx) return null;
  return <RescueInner ctx={ctx} />;
}

function RescueInner({ ctx }: { ctx: EarnV22Context }) {
  const r = useRescueV22(ctx);
  const [amount, setAmount] = useState('');
  if (r.view.wound) {
    return <StatusLine message={{ kind: 'rescue-floor', variant: 'info', title: 'Winding down', body: V22_COPY.rescue.wound }} />;
  }
  if (!r.view.visible) return null;
  let atoms: bigint | null = null;
  try { atoms = amount ? parseHumanAmount(amount, ctx.decimals) : null; } catch { atoms = null; }
  const q = atoms ? r.quote(atoms) : null;
  const minHuman = fmtTokens(Number(r.view.minAtoms) / 10 ** ctx.decimals);
  return (
    <div data-testid="rescue-action" className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 hud-corners">
      <h3 className="mb-1 text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>{V22_COPY.rescue.title}</h3>
      <p className="mb-2 text-[11px] text-[var(--text-secondary)]">{V22_COPY.rescue.explain}</p>
      {r.view.pricePerShare !== null && (
        <p data-testid="rescue-price" className="mb-2 text-[12px] tabular-nums text-[var(--text)]" style={{ fontFamily: 'var(--font-mono)' }}>
          {V22_COPY.rescue.price(`$${r.view.pricePerShare.toFixed(4)}`)}
        </p>
      )}
      <div className="flex gap-2">
        <input
          data-testid="rescue-amount" type="number" min="0" step="any" value={amount} placeholder={`${minHuman}+`}
          onChange={(e) => setAmount(e.target.value)} disabled={r.busy}
          className="flex-1 border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] tabular-nums text-[var(--text)] outline-none"
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <button
          type="button" data-testid="rescue-submit"
          disabled={!r.connected || !atoms || !q?.admitted || r.busy}
          onClick={() => atoms && void r.rescue(atoms).then(() => setAmount(''))}
          className="border border-[var(--accent)]/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-text)] disabled:opacity-40"
        >
          Add
        </button>
      </div>
      {q?.admitted && q.minShares !== null && (
        <p data-testid="rescue-floor" className="mt-1 text-[11px] text-[var(--text-muted)]">{V22_COPY.rescue.floor(fmtTokens(Number(q.minShares) / 10 ** ctx.decimals))}</p>
      )}
      {q && !q.admitted && q.refusal?.reason === 'Amount' && (
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Add at least {minHuman}.</p>
      )}
      {r.message && <StatusLine message={r.message} className="mt-3" />}
    </div>
  );
}
