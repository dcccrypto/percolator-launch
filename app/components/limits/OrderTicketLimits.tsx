"use client";

/**
 * Order-ticket limits, the "Details" drawer half (plan §2, UX WP-3 §4.2): live max size per
 * side + reason, the oracle band and the P2 pre-trade quote (fee cap + margin). The notices
 * that used to stack here (clamp, halted side, same-owner, step-down, fill result) are the
 * ticket's ONE status slot / inline helpers now (lib/limits/ticket-state.ts).
 * Pure renderer of `deriveTicketLimits` (lib/limits/ticket.ts).
 */
import { type FC } from "react";
import { COPY } from "@/lib/limits/copy";
import type { TicketLimits } from "@/lib/limits/ticket";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { bandEdgesE6, effectiveLpExposureKBps } from "@/lib/limits/risk-limits";
import type { Side } from "@/lib/limits/risk-limits";
import { formatLotPriceE6 } from "@/lib/v22/lot";
import { LimitsRow, fmtBandPct, fmtBps } from "./LimitsRow";
import { fmtQ as fmtQRaw } from "@/lib/limits/format";
import { clampFeeCapMarginBps } from "@/lib/limits/fee-channel";

export interface OrderTicketLimitsProps {
  limits: MarketLimits;
  ticket: TicketLimits;
  direction: Side;
  symbol: string;
  /** v2.2 lot exponent: sizes in lots / prices per lot are shown as tokens / per-token prices. */
  lotExp?: number;
  /** Fee-cap slippage margin (bps) and its setter (P2 fee channel). */
  feeMarginBps?: number;
  onFeeMarginChange?: (bps: number) => void;
}

/** Sizes are shown in TOKENS: a Q in lots is scaled by 10^lotExp (lib/v22/lot.ts); the default lotExp 0 is the identity. */
export const fmtQ = (q: bigint, lotExp = 0): string => fmtQRaw(lotExp > 0 ? q * 10n ** BigInt(lotExp) : q);

export function reasonCopy(t: TicketLimits, limits: MarketLimits, side: Side): string {
  const lim = t.sideLimits?.[side];
  if (!lim) return "";
  switch (lim.reason) {
    case "lp-exposure": {
      const k = limits.riskLimits && limits.engine ? effectiveLpExposureKBps(limits.riskLimits.lpExposureKBps, limits.engine.initialMarginBps) : 0;
      return COPY.reason["lp-exposure"]((k / 10_000).toFixed(k % 10_000 === 0 ? 0 : 2));
    }
    case "side-oi":
      return COPY.reason["side-oi"](side);
    case "matcher-fill":
      return COPY.reason["matcher-fill"]();
    case "matcher-inventory":
      return COPY.reason["matcher-inventory"]();
    case "lp-halt":
      return COPY.reason["lp-halt"]();
    case "same-owner":
      return COPY.reason["same-owner"]();
    case "vault-lp-exposure": {
      const lev = limits.vaultLp?.vaultLpMaxLevBps || 10_000;
      return COPY.reason["vault-lp-exposure"]((lev / 10_000).toFixed(lev % 10_000 === 0 ? 0 : 2));
    }
    default:
      return "";
  }
}

export const OrderTicketLimits: FC<OrderTicketLimitsProps> = ({
  limits,
  ticket,
  direction,
  symbol,
  lotExp = 0,
  feeMarginBps,
  onFeeMarginChange,
}) => {
  if (limits.state === "off") return null;
  const loading = limits.state === "loading";
  const p1 = limits.flags.p1;
  const sl = ticket.sideLimits;

  return (
    <div data-testid="limits-order-ticket" data-state={limits.state}>
      {p1 && (
        <div className="mb-3 space-y-0.5">
          {(["long", "short"] as const).map((side) => {
            const lim = sl?.[side];
            return (
              <LimitsRow
                key={side}
                testId="limits-max-size"
                data={{ side, "max-q": lim ? lim.maxQ.toString() : "", state: loading ? "loading" : lim ? "ready" : "error" }}
                label={`Max ${side}`}
                tooltip="Largest size that fills in full right now: the market's liquidity cap, the protocol open-interest cap and the market's per-trade limit, whichever is tightest. Updates live."
                value={loading || !lim ? "—" : lim.halted ? "Paused" : `${fmtQ(lim.maxQ, lotExp)} ${symbol}`}
                valueClass={lim?.halted ? "text-[var(--short)]" : side === direction ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}
              />
            );
          })}
          {sl && sl[direction].reason !== "none" && (
            <p
              className="text-[9px] leading-relaxed text-[var(--text-dim)]"
              data-testid="limits-max-size-reason"
              data-reason={sl[direction].reason}
            >
              {reasonCopy(ticket, limits, direction)}
            </p>
          )}
          {limits.bandBps !== null && limits.engine && (
            <LimitsRow
              testId="limits-band"
              data={{ "band-bps": String(limits.bandBps) }}
              label="Price band"
              tooltip={COPY.bandTooltip}
              value={(() => {
                const { lo, hi } = bandEdgesE6(limits.engine.effectivePriceE6, limits.bandBps);
                return `${fmtBandPct(limits.bandBps)} (${formatLotPriceE6(lo, lotExp)} – ${formatLotPriceE6(hi, lotExp)})`;
              })()}
            />
          )}
        </div>
      )}

      {limits.flags.p2 && ticket.quote && (
        <QuotePanel limits={limits} ticket={ticket} symbol={symbol} lotExp={lotExp} feeMarginBps={feeMarginBps} onFeeMarginChange={onFeeMarginChange} />
      )}
    </div>
  );
};

const QuotePanel: FC<{
  limits: MarketLimits;
  ticket: TicketLimits;
  symbol: string;
  lotExp?: number;
  feeMarginBps?: number;
  onFeeMarginChange?: (bps: number) => void;
}> = ({ limits, ticket, symbol, lotExp = 0, feeMarginBps, onFeeMarginChange }) => {
  const q = ticket.quote!;
  const mark = limits.engine?.effectivePriceE6 ?? 0n;
  // Charged when the protocol enabled the fee channel on-chain (or the manual override flag).
  const charged = ticket.fee?.charged ?? limits.flags.p2FeeCharged;
  const slippage = ticket.issues.find((x) => x.kind === "quote-slippage");
  return (
    <div
      className="mb-3 border border-[var(--border)]/50 bg-[var(--bg-elevated)] px-3 py-2 space-y-0.5"
      data-testid="limits-quote"
      data-kind={q.kind}
      data-state={limits.state}
    >
      <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">Pre-trade quote</p>
      <LimitsRow testId="limits-quote-row" data={{ row: "mark" }} label="Mark" value={formatLotPriceE6(mark, lotExp)} />
      {q.kind === "adaptive" ? (
        <>
          <LimitsRow
            testId="limits-quote-row"
            data={{ row: "quote" }}
            label="Price quote"
            value={q.quotePriceE6 === null ? "No fill" : `${formatLotPriceE6(q.quotePriceE6, lotExp)} (${fmtBps(q.totalBps ?? 0n)})`}
          />
          <LimitsRow testId="limits-quote-row" data={{ row: "base" }} label="Base spread" value={fmtBps(q.baseSpreadBps)} />
          <LimitsRow
            testId="limits-quote-row"
            data={{ row: "fee-adaptive" }}
            label={q.feeCold ? "Adaptive fee (cold)" : "Adaptive fee"}
            tooltip={COPY.feeEstimate}
            value={fmtBps(q.adaptiveFeeBps ?? 0n)}
          />
          <LimitsRow testId="limits-quote-row" data={{ row: "impact" }} label="Size impact" value={fmtBps(q.impactBps ?? 0n)} />
          <LimitsRow
            testId="limits-quote-row"
            data={{ row: "skew" }}
            label={(q.skewBps ?? 0n) < 0n ? "Thin-side rebate" : "Skew surcharge"}
            value={fmtBps(q.skewBps ?? 0n)}
            valueClass={(q.skewBps ?? 0n) < 0n ? "text-[var(--long)]" : (q.skewBps ?? 0n) > 0n ? "text-[var(--short)]" : undefined}
          />
          {q.clippedByTotal && (
            <p className="text-[9px] text-[var(--warning)]">{COPY.quoteClipped(`${fmtQ(q.fillQ, lotExp)} ${symbol}`)}</p>
          )}
        </>
      ) : (
        <LimitsRow testId="limits-quote-row" data={{ row: "quote" }} label="Price quote" value={COPY.legacyQuote(`${(Number(q.maxTotalBps) / 100).toFixed(2)}%`)} />
      )}
      {limits.bandBps !== null && (
        <LimitsRow testId="limits-quote-row" data={{ row: "band" }} label="Band" value={fmtBandPct(limits.bandBps)} />
      )}
      <LimitsRow
        testId="limits-quote-row"
        data={{ row: charged ? "fee-charged" : "settles" }}
        label={charged ? "Fee charged (quote)" : "Settles at"}
        value={charged && ticket.fee ? fmtBps(ticket.fee.requestedBps) : "Mark"}
        valueClass={charged ? "text-[var(--warning)]" : undefined}
      />
      {charged && ticket.fee && ticket.fee.channel.enabled && (
        <>
          <LimitsRow
            testId="limits-fee-cap"
            data={{ "signed-bps": ticket.fee.signedFeeBps.toString(), "margin-bps": ticket.fee.marginBps.toString() }}
            label="Max fee you consent to"
            tooltip={COPY.feeCapTooltip}
            value={
              ticket.fee.utilFeeBps !== undefined
                ? `${ticket.fee.signedFeeBps} bps (base + quote ${ticket.fee.requestedBps} + busy-side ${ticket.fee.utilFeeBps} + margin ${ticket.fee.marginBps})`
                : `${ticket.fee.signedFeeBps} bps (base + quote ${ticket.fee.requestedBps} + margin ${ticket.fee.marginBps})`
            }
            valueClass="text-[var(--text)]"
          />
          {onFeeMarginChange && (
            <label className="flex items-center justify-between text-[10px]">
              <span className="uppercase tracking-[0.08em] text-[var(--text-secondary)]">Fee slippage margin</span>
              <span className="flex items-center gap-1">
                <input
                  data-testid="limits-fee-margin-input"
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  value={feeMarginBps ?? 0}
                  onChange={(e) => onFeeMarginChange(clampFeeCapMarginBps(Number(e.target.value)))}
                  className="w-12 rounded-none border border-[var(--border)] bg-[var(--bg)] px-1 py-0.5 text-right font-mono text-[10px] text-[var(--text)]"
                />
                <span className="font-mono text-[var(--text-secondary)]">× 0.01%</span>
              </span>
            </label>
          )}
        </>
      )}
      <p className="pt-1 text-[9px] leading-relaxed text-[var(--text-dim)]">{charged ? COPY.quoteCharged : COPY.quoteSettlesAtMark}</p>
      {ticket.issues
        .filter((x) => x.kind === "fee-over-max")
        .map((x) => (
          <p key={x.kind} className="text-[9px] text-[var(--short)]" data-testid="limits-quote-fee-over-max">
            {x.message}
          </p>
        ))}
      {slippage && (
        <p className="text-[9px] text-[var(--warning)]" data-testid="limits-quote-slippage-warning">
          {slippage.message}
        </p>
      )}
    </div>
  );
};
