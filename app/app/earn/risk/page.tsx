import type { Metadata } from "next";
import Link from "next/link";
import { EARN_RISK_PAGE as P } from "@/lib/v22/earn-risk-page";

export const metadata: Metadata = { title: P.title };

/** D3: the backtest lives here and only here. The deposit flow never quotes it. */
export default function EarnRiskPage() {
  return (
    <main data-testid="earn-risk-page" className="mx-auto max-w-[72ch] px-4 py-10 text-[13px] leading-relaxed text-[var(--text-secondary)]">
      <h1 className="mb-4 text-xl font-bold text-[var(--text)]">{P.title}</h1>
      <section data-testid="earn-risk-mechanism" className="space-y-3">
        {P.mechanism.map((t) => (
          <p key={t}>{t}</p>
        ))}
      </section>
      <section className="mt-6 space-y-2">
        <h2 className="text-sm font-bold text-[var(--text)]">{P.stopTitle}</h2>
        <p data-testid="earn-risk-stop">{P.stop}</p>
        <p>{P.stopMore}</p>
      </section>
      <section data-testid="earn-risk-backtest" className="mt-6 space-y-2 border border-[var(--border)] p-3">
        <h2 className="text-sm font-bold text-[var(--text)]">{P.backtestTitle}</h2>
        <p data-testid="earn-risk-backtest-label" className="font-semibold text-[var(--warning)]">{P.backtestLabel}</p>
        {P.backtest.map((t) => (
          <p key={t}>{t}</p>
        ))}
        <p>{P.backtestEnd}</p>
      </section>
      <p className="mt-6">
        <Link href="/earn" className="text-[var(--accent-text)] underline underline-offset-4">{P.back}</Link>
      </p>
    </main>
  );
}
