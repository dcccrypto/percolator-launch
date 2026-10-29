"use client";

/**
 * D2 gate (v22 deep memo 2026-10-29): "Positions reduced without your order". A position that silently shrinks is the worst
 * experience in a perp app; the LP stop (W1) is permissionless on rc23, so every cut it makes, and every liquidation / wind-down /
 * eviction, is listed here with the same plain line the trade notice uses (lib/v22/reduce-copy.ts). v2.2 only.
 */
import { FC } from "react";
import Link from "next/link";
import { useReduceEvents } from "@/hooks/useReduceEvents";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { explorerTxUrl } from "@/lib/config";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const REDUCE_EVENTS_COPY = {
  title: "Positions reduced without your order",
  lead: "Every time one of your positions was cut or closed by the market's rules rather than by you, with the reason.",
  empty: "None of your positions has been reduced without your order.",
  unavailable: "This history can't be loaded right now. That does not mean nothing happened: check again later.",
  loading: "Loading…",
  lpStop: "Liquidity stop",
  tx: "transaction",
} as const;

const when = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

export const ReduceEventsPanel: FC = () => {
  const { publicKey } = useWalletCompat();
  const { loading, available, events } = useReduceEvents();
  if (!isDevnetV22Enabled() || !publicKey) return null;

  return (
    <section data-testid="reduce-events" className="mx-auto mt-6 max-w-[1400px] border border-[var(--border)]">
      <div className="border-b border-[var(--border)]/50 px-4 py-2.5">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">{REDUCE_EVENTS_COPY.title}</h2>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">{REDUCE_EVENTS_COPY.lead}</p>
      </div>
      {loading ? (
        <p className="px-4 py-3 text-[11px] text-[var(--text-secondary)]">{REDUCE_EVENTS_COPY.loading}</p>
      ) : events.length === 0 ? (
        available ? (
          <p data-testid="reduce-events-empty" className="px-4 py-3 text-[11px] text-[var(--text-secondary)]">{REDUCE_EVENTS_COPY.empty}</p>
        ) : (
          <p data-testid="reduce-events-unavailable" role="status" className="px-4 py-3 text-[11px] text-[var(--warning)]">{REDUCE_EVENTS_COPY.unavailable}</p>
        )
      ) : (
        <>
          {!available && (
            <p data-testid="reduce-events-unavailable" role="status" className="px-4 pt-3 text-[10px] text-[var(--warning)]">{REDUCE_EVENTS_COPY.unavailable}</p>
          )}
          <ul className="divide-y divide-[var(--border)]/30">
            {events.map((e) => (
              <li key={`${e.signature}:${e.portfolio}`} data-testid="reduce-event-row" className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-[11px] font-medium text-[var(--text)]">
                    {e.title}
                    {e.lpStop && (
                      <span data-testid="reduce-event-lp-stop" className="border border-[var(--warning)]/40 px-1.5 text-[9px] uppercase tracking-[0.1em] text-[var(--warning)]">
                        {REDUCE_EVENTS_COPY.lpStop}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">{when(e.at)}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">{e.body}</p>
                <div className="mt-1 flex gap-4 text-[10px]">
                  {e.market && (
                    <Link href={`/trade/${e.market}`} className="text-[var(--accent)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {e.market.slice(0, 4)}…{e.market.slice(-4)} →
                    </Link>
                  )}
                  <a href={explorerTxUrl(e.signature)} target="_blank" rel="noopener noreferrer" className="text-[var(--text-secondary)] underline decoration-dotted">
                    {REDUCE_EVENTS_COPY.tx}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
