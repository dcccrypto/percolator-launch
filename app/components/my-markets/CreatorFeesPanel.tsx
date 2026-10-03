"use client";

/**
 * "Unclaimed fees" section for /my-markets.
 *
 * Creator fees were claimable ONLY from a panel buried inside each row's expand
 * drawer: no totals, no per-market figure on the surface, and a creator with
 * eight markets had to open eight drawers to find out whether they had earned
 * anything. This is the surface answer — per market, with a total, and a single
 * claim-all.
 *
 * SUMMARY ONLY — no per-market rows. The first version of this panel listed
 * every market, which reproduced the market list a third time on a page that
 * already showed it twice (#2573). The per-market figure and its claim button
 * live on CreatorMarketRow instead, so the page has ONE list and the row
 * carries the detail.
 *
 * THE DISPLAY RULE, which is the whole point: a balance that could not be READ
 * renders as "unavailable", never as a zero. `/api/markets/[slab]`'s Supabase
 * branch used to return no creator-fee field at all, and the row collapsed that
 * to `0n` — so every creator was told they had earned nothing. An unknown
 * balance is also excluded from the total and from claim-all, because tag 90 is
 * exact-amount and would reject a guess.
 */

import { FC, useMemo } from "react";
import type { CreatedMarket } from "@/hooks/useCreatedMarkets";
import type { CreatorMarketDetail } from "./types";
import { unitScaleToDecimals } from "./types";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { explorerTxUrl } from "@/lib/config";
import { claimAllResultCopy, useClaimCreatorFees } from "@/hooks/useClaimCreatorFees";
import {
  classifyClaimable,
  summarizeCreatorFees,
  claimAllTargets,
  type CreatorFeeEntry,
} from "@/lib/creator-fee-summary";
import { resolveIdentity, type ResolvedIdentity } from "@/lib/bulk-identity";

interface CreatorFeesPanelProps {
  markets: CreatedMarket[];
  details: Record<string, CreatorMarketDetail>;
  identities: Record<string, ResolvedIdentity>;
  /** Re-read balances after a successful claim. */
  onClaimed?: () => void;
}

const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });

export const CreatorFeesPanel: FC<CreatorFeesPanelProps> = ({
  markets,
  details,
  identities,
  onClaimed,
}) => {
  const wallet = useWalletCompat();
  const { claim, busy, outcomes, progress } = useClaimCreatorFees();
  const connected = wallet.publicKey?.toBase58() ?? null;

  const entries = useMemo<(CreatorFeeEntry & { label: string })[]>(
    () =>
      markets.map((m) => {
        const slab = m.slabAddress.toBase58();
        const detail = details[slab] ?? null;
        const identity = resolveIdentity(detail, identities[slab] ?? null);
        const cfg = m.configV17 as { collateralMint?: { toBase58: () => string }; unitScale?: number } | undefined;
        return {
          slab,
          label: identity.symbol ?? m.label,
          claimable: classifyClaimable(detail?.creator_fee_claimable_atoms),
          collateralMint: cfg?.collateralMint?.toBase58() ?? null,
          decimals: unitScaleToDecimals(cfg?.unitScale ?? m.config?.unitScale),
          // tag 90 accepts asset 0's asset_admin only. Fails closed: an unknown
          // authority is NOT "probably me".
          isClaimAuthority:
            connected != null &&
            detail?.creator_fee_authority != null &&
            detail.creator_fee_authority === connected,
        };
      }),
    [markets, details, identities, connected],
  );

  const summary = useMemo(() => summarizeCreatorFees(entries), [entries]);
  const targets = useMemo(() => claimAllTargets(entries), [entries]);
  const labelFor = (slab: string) =>
    entries.find((e) => e.slab === slab)?.label ?? slab.slice(0, 8);

  if (markets.length === 0) return null;

  // Re-read balances as EACH claim confirms (the figure and "N markets have fees" drop while the
  // rest are still going), and once more at the end on every path: a partial success or a
  // failure after one claim landed must never leave the panel showing the old figure.
  const runClaim = async (slabs: readonly string[]) => {
    try {
      await claim(slabs, { onLanded: () => onClaimed?.() });
    } finally {
      onClaimed?.();
    }
  };

  return (
    <div className="mb-8 border border-[var(--border)] bg-[var(--panel-bg)]">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--border)]/60 px-4 py-3">
        <div>
          {/* "Unclaimed", NOT "Earned". The on-chain counter is decremented by
              every claim (tag 90 is the only thing that touches it), so it is
              the CURRENTLY CLAIMABLE balance and cannot state lifetime revenue.
              Labelling it "Fees Earned" would promise a figure this number is
              not — a creator who had already claimed would read their remaining
              balance as their total takings. Lifetime earned needs claim
              history, which the indexer does not track today; deliberately out
              of scope. */}
          <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">
            Unclaimed Fees
          </p>
          <p className="mt-1 text-[10px] text-[var(--text-dim)]">
            Your share of trading fees on your markets, still sitting on chain.
            Claimed manually — nothing is sent automatically, and this figure
            drops to zero as you claim it.
          </p>
        </div>

        <div className="text-right">
          {summary.allUnknown ? (
            // NOT "$0.00": nothing could be read, so there is no total to show.
            <p className="text-[12px] text-[var(--text-dim)]">balance unavailable</p>
          ) : summary.totalsByMint.length === 0 ? (
            <p className="text-[12px] text-[var(--text-secondary)]">nothing unclaimed</p>
          ) : (
            summary.totalsByMint.map((t) => (
              <p
                key={t.collateralMint}
                className="text-lg font-bold tabular-nums text-[var(--text)]"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {fmt(t.total)}
                {summary.totalsByMint.length > 1 && (
                  <span className="ml-1 text-[10px] font-normal text-[var(--text-dim)]">
                    {t.collateralMint.slice(0, 4)}…
                  </span>
                )}
              </p>
            ))
          )}
          {summary.unknownMarkets > 0 && !summary.allUnknown && (
            // The total is real for what was readable — say so rather than
            // presenting it as covering every market.
            <p className="text-[10px] text-[var(--warning)]">
              {summary.unknownMarkets} of {markets.length} unreadable, not included
            </p>
          )}
        </div>
      </div>

      {targets.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)]/40 bg-[var(--accent)]/[0.03] px-4 py-2.5">
          <p className="text-[11px] text-[var(--text-secondary)]">
            {summary.claimableMarkets === 1
              ? "1 market has fees you can claim"
              : `${summary.claimableMarkets} markets have fees you can claim`}
            {summary.marketsWithFees > summary.claimableMarkets && (
              <span className="ml-1 text-[var(--text-dim)]">
                ({summary.marketsWithFees - summary.claimableMarkets} earned on a market whose admin
                is another wallet)
              </span>
            )}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runClaim(targets)}
            className="shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.15] disabled:opacity-50"
          >
            {busy
              ? progress.total > 1
                ? `claiming… (${Math.min(progress.done + 1, progress.total)}/${progress.total})`
                : "claiming…"
              : `claim all (${targets.length})`}
          </button>
        </div>
      )}

      {outcomes.length > 0 && (
        <div className="border-t border-[var(--border)]/40 px-4 py-2.5">
          {/* UX WP-9 (§3.11): one line, "Claimed {total} from {n} markets." (+ the partial clause). */}
          <p data-testid="creator-claim-result" className={`text-[10px] ${outcomes.some((o) => o.signature) ? "text-[var(--long)]" : "text-[var(--text-secondary)]"}`}>
            {claimAllResultCopy(outcomes, (atoms) => fmt(Number(atoms) / 10 ** (entries[0]?.decimals ?? 6)))}
          </p>
          {/* Per-market failures are listed, not counted: a claim-all sends one
              transaction PER market precisely so a partial failure is
              survivable, which is only useful if the creator can see which
              ones to retry. */}
          {outcomes.filter((o) => o.error).map((o) => (
            <p key={o.slab} data-testid="creator-claim-unclaimed" className="text-[10px] text-[var(--text-secondary)]">
              {labelFor(o.slab)} not claimed: {o.error}
            </p>
          ))}
          {/* #2742: sent but not confirmed before the poll deadline — it may still land, so it is
              neither "claimed" nor "not claimed"; the signature is the creator's way to check. */}
          {outcomes.filter((o) => !o.signature && o.pendingSignature).map((o) => (
            <p key={o.slab} data-testid="creator-claim-pending" className="text-[10px] text-[var(--text-secondary)]">
              {labelFor(o.slab)} sent, not confirmed yet.{" "}
              <a href={explorerTxUrl(o.pendingSignature!)} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:brightness-125">
                check on explorer ↗
              </a>
            </p>
          ))}
        </div>
      )}
    </div>
  );
};
