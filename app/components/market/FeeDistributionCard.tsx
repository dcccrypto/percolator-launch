"use client";

import { FC, useMemo } from "react";
import { FEE_SPLIT } from "@percolatorct/sdk";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatUsdFromNumber } from "@/lib/format";
import { legLabel } from "@/lib/fee-breakdown";

/**
 * Fee distribution — how each trade fee is split four ways, and how much has
 * reached each leg. Reads the SDK-parsed `WrapperConfigV17` directly (no
 * hand-rolled byte offsets):
 *
 *  - SHARE (exact policy): `FEE_SPLIT.PROTOCOL_FEE_BPS` (fixed) + the three
 *    creator/lp/insurance share bps, each a share of the whole trade fee T.
 *  - COLLECTED (realized): the on-chain cumulative `*_accrued` counters for
 *    protocol / LP / insurance. The creator leg is asset 0's per-asset
 *    `creatorFeeClaimableAtoms` (GH#420) PLUS the legacy config-level counter
 *    of the same name — see `lib/v17-creator-fee.ts` for why both are needed
 *    (the config counter alone under-reports on every market seeded after
 *    GH#420, percolator-prog#507). It goes down when the creator claims, so it
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
  const { wrapperConfigV17: cfg, assetProfile } = useSlabState();
  const tokenMeta = useTokenMeta(cfg?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;

  const legs = useMemo(() => {
    if (!cfg) return null;
    const toUsd = (a: bigint) => Number(a) / 10 ** decimals;
    // GH#420: the creator leg accrues into asset 0's per-asset counter now, not
    // (only) this config-level one — see lib/v17-creator-fee.ts. `assetProfile`
    // is null on a v12 slab or a truncated account; fall back to the legacy
    // pot alone rather than fabricating a per-asset value.
    const creatorAtoms = cfg.creatorFeeClaimableAtoms + (assetProfile?.creatorFeeClaimableAtoms ?? 0n);
    return [
      { key: "protocol", label: legLabel("protocol"), bps: FEE_SPLIT.PROTOCOL_FEE_BPS, usd: toUsd(cfg.protocolFeeAccruedAtoms), note: "collected" },
      { key: "creator", label: legLabel("creator"), bps: cfg.creatorShareBps, usd: toUsd(creatorAtoms), note: "claimable" },
      { key: "lp", label: legLabel("lp"), bps: cfg.lpShareBps, usd: toUsd(cfg.lpFeeAccruedAtoms), note: "collected" },
      { key: "insurance", label: legLabel("insurance"), bps: cfg.insuranceShareBps, usd: toUsd(cfg.insuranceReserveAccruedAtoms), note: "collected" },
    ];
  }, [cfg, assetProfile, decimals]);

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
