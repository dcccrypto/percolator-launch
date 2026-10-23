'use client';

/**
 * Deposit into a first-loss (stake v5) pool: the pool's target, liquid buffer and rebalance band, the consent
 * text v2 verbatim, a required checkbox, then Deposit. Renders nothing unless the pool is a v5 first-loss pool, or
 * `expected` (the API already marks it first-loss): then, until the pool's own read succeeds, a reading line or a
 * "couldn't read" line with Retry, never nothing and never the plain form (#3607).
 */
import { firstLossStakeErrorMessage } from "@/lib/earnErrors";
import { useEffect, useState } from 'react';
import { useStakeFirstLoss } from '@/hooks/useStakeFirstLoss';
import { ConsentChangedError, consentKey, consentTextMatches, consentViewOf, pctOfBps } from '@/lib/v22/stake-v5';
import { STAKE_CONSENT_TEXT_V2, V22_COPY, consentDisplay } from '@/lib/v22/copy';
import { parseHumanAmount } from '@/lib/parseAmount';

type FirstLossState = ReturnType<typeof useStakeFirstLoss>;

export function FirstLossDeposit({ slabAddress, collateralMint, decimals = 6, deployedUsd, onDone, state, expected = false }: {
  slabAddress: string;
  collateralMint: string;
  decimals?: number;
  /** Insurance deployed for this pool, USD; null = unreadable; undefined = not shown. */
  deployedUsd?: number | null;
  onDone?: () => void;
  /** The caller's own `useStakeFirstLoss` for this pool, so the pool is read once and both agree on its state. */
  state?: FirstLossState;
  /** The API marks this pool first-loss: show a reading / couldn't-read state instead of nothing while `pool` is null. */
  expected?: boolean;
}) {
  // With `state` passed, the local hook gets no market and stays idle (no RPC).
  const own = useStakeFirstLoss(state ? '' : slabAddress, state ? '' : collateralMint);
  const { pool, deposit, loading, status, retry } = state ?? own;
  const [amount, setAmount] = useState('');
  const [accepted, setAccepted] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const view = pool ? consentViewOf(pool) : null;
  const key = view ? consentKey(view) : null;

  // Consent covers exactly the numbers on screen: when they change, the checkbox resets.
  useEffect(() => {
    setAccepted((prev) => (prev !== null && prev !== key ? null : prev));
  }, [key]);

  if (!view) {
    if (!expected) return null;
    if (status === 'loading' || status === 'idle') {
      return <p data-testid="first-loss-reading" role="status" className="text-[11px] text-[var(--text-secondary)]">{V22_COPY.stake.poolReading}</p>;
    }
    return (
      <div data-testid="first-loss-read-failed" className="flex items-center justify-between gap-3 text-[11px] text-[var(--text-secondary)]">
        <p role="status">{V22_COPY.stake.poolReadFailed}</p>
        <button type="button" data-testid="first-loss-retry" onClick={() => retry()}
          className="shrink-0 border border-[var(--border)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text)] hover:border-[var(--accent)]/40">
          {V22_COPY.stake.retry}
        </button>
      </div>
    );
  }
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
      else setNote(firstLossStakeErrorMessage(e)); // #3608: never raw simulation, log or RPC text
    }
  };

  return (
    <div data-testid="first-loss-deposit" className="space-y-3">
      <h4 className="text-[12px] font-medium text-[var(--text)]" style={{ fontFamily: 'var(--font-display)' }}>{V22_COPY.stake.title}</h4>
      {deployedUsd !== undefined && (
        <p data-testid="fl-deployed" className="text-[11px] tabular-nums text-[var(--text-secondary)]">
          {deployedUsd === null ? V22_COPY.stake.deployedUnknown : V22_COPY.stake.deployed(deployedUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }))}
        </p>
      )}
      <dl className="grid grid-cols-3 gap-2 text-[11px]" data-testid="first-loss-params">
        <div><dt className="text-[var(--text-secondary)]">Target</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-target">{pctOfBps(view.targetBps)}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Liquid buffer</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-buffer">{pctOfBps(view.bufferBps)}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Rebalance band</dt><dd className="tabular-nums text-[var(--text)]" data-testid="fl-hysteresis">{pctOfBps(view.hysteresisBps)}</dd></div>
      </dl>
      <div data-testid="consent-text" className="max-h-48 space-y-2 overflow-y-auto border border-[var(--border)] bg-[var(--bg-surface)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        <p data-testid="consent-summary" className="font-medium text-[var(--text)]">{V22_COPY.stake.consentSummary}</p>
        <p data-testid="consent-closeout" className="text-[var(--text)]">{V22_COPY.stake.closeOut.firstLoss}</p>
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
