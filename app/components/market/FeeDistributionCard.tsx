"use client";

import { FC, useMemo } from "react";
import { FEE_SPLIT } from "@percolatorct/sdk";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatUsdFromNumber } from "@/lib/format";

/**
 * Fee distribution — how each trade fee is split four ways, and how much has
 * reached each leg. Reads the SDK-parsed `WrapperConfigV17` directly (no
 * hand-rolled byte offsets):
 *
 *  - SHARE (exact policy): `FEE_SPLIT.PROTOCOL_FEE_BPS` (fixed) + the three
 *    creator/lp/insurance share bps, each a share of the whole trade fee T.
 *  - COLLECTED (realized): the on-chain cumulative `*_accrued` counters for
 *    protocol / LP / insurance. The creator leg uses a SINGLE counter
 *    (`creatorFeeClaimableAtoms`) that goes down when the creator claims, so it
 *    reflects "claimable now", not a cumulative total — labelled distinctly so
 *    the number is never read as "total ever earned".
 */
const LEG_COLORS: Record<string, string> = {
  protocol: "var(--text-dim)",
  creator: "var(--accent)",
  lp: "var(--long)",
  insurance: "var(--short)",
};

function pctStr(bps: number): string {
  const p = (bps / 10_000) * 100;
  return (Number.isInteger(p) ? p.toFixed(0) : p.toFixed(1)) + "%";
}

export const FeeDistributionCard: FC = () => {
  const { wrapperConfigV17: cfg } = useSlabState();
  const tokenMeta = useTokenMeta(cfg?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;

  const legs = useMemo(() => {
    if (!cfg) return null;
    const toUsd = (a: bigint) => Number(a) / 10 ** decimals;
    return [
      { key: "protocol", label: "Protocol", bps: FEE_SPLIT.PROTOCOL_FEE_BPS, usd: toUsd(cfg.protocolFeeAccruedAtoms), note: "collected" },
      { key: "creator", label: "Creator", bps: cfg.creatorShareBps, usd: toUsd(cfg.creatorFeeClaimableAtoms), note: "claimable" },
      { key: "lp", label: "LP", bps: cfg.lpShareBps, usd: toUsd(cfg.lpFeeAccruedAtoms), note: "collected" },
      { key: "insurance", label: "Insurance", bps: cfg.insuranceShareBps, usd: toUsd(cfg.insuranceReserveAccruedAtoms), note: "collected" },
    ];
  }, [cfg, decimals]);

  if (!cfg || !legs) {
    return (
      <p className="text-[11px] text-[var(--text-dim)]">
        Fee split is a v17 feature — unavailable on this market.
      </p>
    );
  }

  const baseFeeBps = Number(cfg.tradeFeeBps);
  const baseFeeStr = (baseFeeBps / 100).toFixed(baseFeeBps % 100 === 0 ? 0 : 2) + "%";

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">trade fee (split 4 ways →)</span>
        <span className="text-[13px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{baseFeeStr}</span>
      </div>

      {/* Proportional split bar */}
      <div className="mb-3 flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        {legs.map((l) => (
          <div key={l.key} style={{ width: pctStr(l.bps), background: LEG_COLORS[l.key] }} title={`${l.label} ${pctStr(l.bps)}`} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-1.5">
        {legs.map((l) => (
          <div key={l.key} className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: LEG_COLORS[l.key] }} />
              <span className="text-[var(--text-dim)]">{l.label}</span>
              <span className="text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{pctStr(l.bps)}</span>
            </span>
            <span className="text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {formatUsdFromNumber(l.usd)}
              <span className="ml-1 text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">{l.note}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[9px] leading-relaxed text-[var(--text-dim)]">
        Shares of each trade fee. Amounts are cumulative on-chain; the creator row shows
        currently-claimable (it uses a single counter, so it drops when the creator claims).
      </p>
    </div>
  );
};
