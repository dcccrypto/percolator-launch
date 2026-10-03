"use client";

/**
 * Trade-page limits strip (plan §2 "Market cards and page"): OI utilisation
 * vs the protocol side cap, LP health / halt state, the oracle band, and the
 * book-skew indicator. Renders nothing with every limits flag off.
 */
import { matcherPricingInventoryQ } from "@/lib/limits/lp-inventory-room";
import { type FC } from "react";
import { useMarketLimits, type MarketLimits } from "@/hooks/useMarketLimits";
import {
  effectiveSideOiCapQ,
  lpEquityInitRaw,
  lpFloorHalts,
  oiUtilisationBps,
} from "@/lib/limits/risk-limits";
import { skewIndicatorBps } from "@/lib/limits/matcher-quote";
import { COPY } from "@/lib/limits/copy";
import { fmtBandPct } from "./LimitsRow";
import { fmtQ } from "./OrderTicketLimits";
import { InfoIcon } from "@/components/ui/Tooltip";

export const MarketLimitsStrip: FC<{ slab: string; symbol: string }> = ({ slab, symbol }) => {
  const limits = useMarketLimits(slab);
  return <MarketLimitsStripView limits={limits} symbol={symbol} />;
};

const Meter: FC<{ side: "long" | "short"; utilBps: number }> = ({ side, utilBps }) => {
  const pct = Math.min(100, utilBps / 100);
  const color = utilBps >= 9_000 ? "var(--short)" : utilBps >= 7_000 ? "var(--warning)" : side === "long" ? "var(--long)" : "var(--short)";
  return (
    <span className="flex items-center gap-1.5" data-testid="limits-oi-meter" data-side={side} data-util-bps={String(utilBps)}>
      <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{side}</span>
      <span className="relative h-1 w-14 bg-[var(--border)]" aria-hidden>
        <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="font-mono tabular-nums text-[10px] text-[var(--text)]">{(utilBps / 100).toFixed(utilBps < 1_000 ? 1 : 0)}%</span>
    </span>
  );
};

/** Pure view (tested directly with a MarketLimits fixture). */
export const MarketLimitsStripView: FC<{ limits: MarketLimits; symbol: string }> = ({ limits, symbol }) => {
  if (limits.state === "off") return null;
  const e = limits.engine;
  const cap = limits.riskLimits ? effectiveSideOiCapQ(limits.riskLimits.sideOiCapQ) : null;
  const halted =
    limits.flags.p1 && limits.lp && limits.riskLimits
      ? lpFloorHalts(lpEquityInitRaw(limits.lp.capital, limits.lp.pnl, limits.lp.feeCredits), limits.riskLimits.lpFloorAtoms, true)
      : null;
  const ref = limits.matcher?.v2?.skewRefInventory ?? 0n;
  // The inventory the matcher prices skew from: the real LP position once the sync is live.
  const pricingInv = limits.matcher
    ? matcherPricingInventoryQ({ counterQ: limits.matcher.inventoryBase, realQ: limits.lpRealQ, syncLive: limits.matcherSyncLive })
    : null;
  const skewBps = limits.flags.p2 && limits.matcher && pricingInv !== null ? skewIndicatorBps(pricingInv, ref) : null;
  const inv = pricingInv ?? 0n;
  // LP short (inv < 0) => traders net long.
  const skewDir: "long" | "short" | "flat" = inv < 0n ? "long" : inv > 0n ? "short" : "flat";

  return (
    <div
      data-testid="limits-market-strip"
      data-state={limits.state}
      className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-[var(--border)] bg-[var(--bg-surface)] px-4 py-1.5 text-[10px]"
    >
      {limits.flags.p1 && e && cap !== null && (
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1 uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            OI vs cap
            <InfoIcon tooltip="Open interest on each side as a share of the protocol's per-side cap. Near the cap, new positions on that side are limited; closing always works." />
          </span>
          <Meter side="long" utilBps={oiUtilisationBps(e.oiEffLongQ, cap)} />
          <Meter side="short" utilBps={oiUtilisationBps(e.oiEffShortQ, cap)} />
        </span>
      )}
      {limits.flags.p1 && halted !== null && (
        <span className="flex items-center gap-1" data-testid="limits-lp-health" data-halted={halted ? "true" : "false"}>
          <span className="uppercase tracking-[0.08em] text-[var(--text-secondary)]">Liquidity</span>
          <span className={`font-mono font-bold uppercase ${halted ? "text-[var(--short)]" : "text-[var(--long)]"}`}>
            {halted ? "Halted" : "Active"}
          </span>
        </span>
      )}
      {limits.flags.p1 && limits.bandBps !== null && (
        <span className="flex items-center gap-1" data-testid="limits-band" data-band-bps={String(limits.bandBps)}>
          <span className="uppercase tracking-[0.08em] text-[var(--text-secondary)]">Band</span>
          <span className="font-mono text-[var(--text)]">{fmtBandPct(limits.bandBps)}</span>
          <InfoIcon tooltip={COPY.bandTooltip} />
        </span>
      )}
      {skewBps !== null && (
        <span className="flex items-center gap-1.5" data-testid="limits-skew" data-skew-bps={String(skewBps)}>
          <span className="uppercase tracking-[0.08em] text-[var(--text-secondary)]">Skew</span>
          <span className="relative h-1 w-16 bg-[var(--border)]" aria-hidden>
            <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--text-dim)]" />
            <span
              className="absolute inset-y-0"
              style={
                skewBps < 0
                  ? { left: "50%", width: `${Math.min(50, -skewBps / 200)}%`, background: "var(--long)" }
                  : { right: "50%", width: `${Math.min(50, skewBps / 200)}%`, background: "var(--short)" }
              }
            />
          </span>
          <span className="text-[var(--text-secondary)]">{COPY.skew(skewDir, fmtQ(inv < 0n ? -inv : inv), symbol)}</span>
        </span>
      )}
      {limits.state === "error" && <span className="text-[var(--warning)]">{COPY.limitsUnavailable}</span>}
    </div>
  );
};
