import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PnlHistoryCard } from "@/components/dashboard/pnl-history/PnlHistoryCard";
import { LOCAL_PNL_HISTORY_FIXTURE } from "@/components/dashboard/pnl-history/local-preview-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default function PnlHistoryDevPreview() {
  // Never expose fabricated PnL as live wallet performance.
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-4 py-8 md:py-12">
      <div className="mb-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--accent-text)]">
          Development Preview
        </p>

        <h1 className="mt-2 text-2xl font-semibold text-[var(--text)]">
          Portfolio PnL Calendar
        </h1>

        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          DEMO DATA — visual testing only. Not real wallet performance.
        </p>
      </div>

      <PnlHistoryCard
        data={LOCAL_PNL_HISTORY_FIXTURE}
        initialMonth="2026-10"
      />
    </main>
  );
}
