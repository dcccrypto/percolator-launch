'use client';

/**
 * Deposit into a first-loss (stake v5) pool: the pool's target, liquid buffer and rebalance band, the consent
 * text v2 verbatim, a required checkbox, then Deposit. Renders nothing unless the pool is a v5 first-loss pool.
 */
import { useEffect, useState } from 'react';
import { useStakeFirstLoss } from '@/hooks/useStakeFirstLoss';
import { ConsentChangedError, consentKey, consentTextMatches, consentViewOf, pctOfBps } from '@/lib/v22/stake-v5';
import { STAKE_CONSENT_TEXT_V2, V22_COPY, consentDisplay } from '@/lib/v22/copy';
import { parseHumanAmount } from '@/lib/parseAmount';

export function FirstLossDeposit({ slabAddress, collateralMint, decimals = 6, onDone }: { slabAddress: string; collateralMint: string; decimals?: number; onDone?: () => void }) {
  const { pool, deposit, loading } = useStakeFirstLoss(slabAddress, collateralMint);
  const [amount, setAmount] = useState('');
  const [accepted, setAccepted] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const view = pool ? consentViewOf(pool) : null;
  const key = view ? consentKey(view) : null;

  // Consent covers exactly the numbers on screen: when they change, the checkbox resets.
  useEffect(() => {
    setAccepted((prev) => (prev !== null && prev !== key ? null : prev));
  }, [key]);

  if (!view) return null;
  // F11: the text below is consent text v2; a pool on another consent version gets no deposit UI at all.
  if (!consentTextMatches(view)) return <p data-testid="first-loss-unavailable" className="text-[11px] text-[var(--text-secondary)]">{V22_COPY.stake.consentUnavailable}</p>;
  let atoms: bigint | null = null;
  try { atoms = amount ? parseHumanAmount(amount, decimals) : null; } catch { atoms = null; }
  const ok = accepted === key && !!atoms && atoms > 0n && !loading;

  const submit = async () => {
    if (!atoms) return;
    setNote(null);
    try {
      await deposit(atoms, view);
      setAmount('');
      onDone?.();
    } catch (e) {
      if (e instanceof ConsentChangedError) { setAccepted(null); setNote(e.message); }
      else setNote(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div data-testid="first-loss-deposit" className="space-y-3">
      <h4 className="text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>{V22_COPY.stake.title}</h4>
      <dl className="grid grid-cols-3 gap-2 text-[11px]" data-testid="first-loss-params">
        <div><dt className="text-[var(--text-secondary)]">Target</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-target">{pctOfBps(view.targetBps)}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Liquid buffer</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-buffer">{pctOfBps(view.bufferBps)}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Rebalance band</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-hysteresis">{pctOfBps(view.hysteresisBps)}</dd></div>
      </dl>
      <div data-testid="consent-text" className="max-h-48 space-y-2 overflow-y-auto border border-[var(--border)] bg-[var(--bg-surface)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        {STAKE_CONSENT_TEXT_V2.map((para, i) => <p key={i} data-testid="consent-para">{consentDisplay(para)}</p>)}
        <p className="text-[var(--text-muted)]">{V22_COPY.stake.consentVersion(view.version)}</p>
      </div>
      <label className="flex items-start gap-2 text-[11px] text-[var(--text)]">
        <input type="checkbox" data-testid="consent-check" checked={accepted === key} onChange={(e) => setAccepted(e.target.checked ? key : null)} className="mt-0.5" />
        <span>{V22_COPY.stake.consentLabel}</span>
      </label>
      <input
        type="number" min="0" step="any" value={amount} placeholder="0.00" data-testid="stake-deposit-input"
        onChange={(e) => setAmount(e.target.value)}
        className="w-full border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2.5 text-[13px] tabular-nums text-[var(--text)] outline-none"
        style={{ fontFamily: 'var(--font-mono)' }}
      />
      <button type="button" data-testid="first-loss-submit" disabled={!ok} onClick={() => void submit()}
        className="w-full border border-[var(--accent)]/40 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-text)] disabled:opacity-40">
        {loading ? '…' : V22_COPY.stake.deposit}
      </button>
      <p data-testid="first-loss-withdraw-note" className="text-[11px] text-[var(--text-muted)]">{V22_COPY.stake.withdraw}</p>
      {note && <p role="status" className="text-[11px] text-[var(--text-secondary)]">{note}</p>}
    </div>
  );
}
