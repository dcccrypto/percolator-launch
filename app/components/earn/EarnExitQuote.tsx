'use client';

/**
 * v2.2 Earn exit step: get the exit price (simulated), show "You'll receive at least X", and only then enable the
 * withdraw button. Rendered by DepositWithdrawPanel under NEXT_PUBLIC_DEVNET_V22 in place of the one-step button.
 * Presentational: the hook (hooks/useEarnExitV22) is injected so the component is testable without a wallet.
 */
import { GlowButton } from '@/components/ui/GlowButton';
import { StatusLine } from '@/components/ui/StatusLine';
import { V22_COPY } from '@/lib/v22/copy';
import { quoteLine, showDipNote } from '@/lib/v22/earn-exit';
import type { EarnExitApi } from '@/hooks/useEarnExitV22';
import type { UserMessage } from '@/lib/limits/user-message';

const calm = (kind: string, variant: 'wait' | 'info', title: string, body: string): UserMessage => ({
  kind,
  variant,
  title,
  body,
  details: { code: null, name: null, programId: null, logs: [], raw: '' },
});

export interface EarnExitQuoteProps {
  exit: Pick<EarnExitApi, 'state' | 'getQuote' | 'confirm'>;
  decimals: number;
  symbol: string;
  /** The amount the user typed is valid and non-zero. */
  canQuote: boolean;
}

export function EarnExitQuote({ exit, decimals, symbol, canQuote }: EarnExitQuoteProps) {
  const { state, getQuote, confirm } = exit;
  const busy = state.phase === 'quoting' || state.phase === 'refreshing' || state.phase === 'sending';
  const quoted = state.phase === 'quoted' && state.quote !== null;
  return (
    <div data-testid="earn-exit-v22" className="mb-2">
      {state.phase === 'refreshing' && (
        <p data-testid="earn-exit-refreshing" className="mb-2 text-[11px] text-[var(--text-secondary)]">{V22_COPY.earnExit.refreshing}</p>
      )}
      {state.phase === 'quoting' && (
        <p data-testid="earn-exit-quoting" className="mb-2 text-[11px] text-[var(--text-secondary)]">{V22_COPY.earnExit.quoting}</p>
      )}
      {quoted && state.quote && (
        <div className="mb-2">
          {state.requoted && (
            <p data-testid="earn-exit-requote" className="mb-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.earnExit.requote}</p>
          )}
          <p data-testid="earn-exit-min" className="text-[13px] font-medium text-[var(--text)]">
            {quoteLine(state.quote.minPayout, decimals, symbol)}
          </p>
          {showDipNote(state.quote.staleCount) && (
            <p data-testid="earn-exit-dip" className="mt-1 text-[11px] text-[var(--text-secondary)]">{V22_COPY.earnExit.dipTolerance}</p>
          )}
        </div>
      )}
      {state.phase === 'wait' && state.message && <StatusLine message={calm('exit-wait', 'wait', 'Refreshing positions', state.message)} />}
      {state.phase === 'error' && state.message && <StatusLine message={calm('exit-note', 'info', 'Not yet', state.message)} />}
      {state.phase === 'sent' && (
        <p data-testid="earn-exit-sent" className="mb-2 text-[11px] text-[var(--text-secondary)]">Sent.</p>
      )}
      <div className="flex gap-2">
        {quoted ? (
          <GlowButton data-testid="earn-exit-confirm" onClick={() => void confirm()} disabled={busy} variant="primary" size="lg" className="flex-1">
            Withdraw
          </GlowButton>
        ) : (
          <GlowButton data-testid="earn-exit-get-quote" onClick={() => void getQuote()} disabled={!canQuote || busy} variant="primary" size="lg" className="flex-1">
            {busy ? 'Working…' : 'See exit price'}
          </GlowButton>
        )}
      </div>
    </div>
  );
}
