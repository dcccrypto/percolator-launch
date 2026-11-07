import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAllocationVoteHost } from "@/lib/allocation-vote/host";

// Direct-URL only: not linked from nav, header, footer or the homepage, and
// not in the sitemap. The vote is disabled server-side; this page has no
// controls and cannot open it.
export const metadata: Metadata = {
  title: "PERC holder vote",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function VotePage() {
  if (!isAllocationVoteHost((await headers()).get("host"))) notFound();
  return (
    <section className="mx-auto max-w-xl px-4 py-20">
      <h1 className="mb-4 text-2xl font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>
        PERC holder vote
      </h1>
      <p className="mb-2 text-[15px] text-[var(--text)]">Voting is not open.</p>
      <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
        No vote is running, and votes cannot be cast here yet. This page never asks for a seed phrase, password or
        transaction.
      </p>
    </section>
  );
}
