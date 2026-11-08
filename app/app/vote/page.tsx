import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAllocationVoteHost } from "@/lib/allocation-vote/host";
import { VoteClient } from "./VoteClient";

// Direct-URL only: not linked from nav, header, footer or the homepage, and
// not in the sitemap. Vote state comes from the server; this page cannot open it.
export const metadata: Metadata = {
  title: "PERC holder vote",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function VotePage() {
  if (!isAllocationVoteHost((await headers()).get("host"))) notFound();
  return (
    <section className="mx-auto max-w-xl px-4 py-16 sm:py-20">
      <h1 className="mb-4 text-2xl font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>
        PERC holder vote
      </h1>
      <p className="mb-2 text-[15px] leading-relaxed text-[var(--text)]">
        Should protocol fees go to weekly fee claims for holders, or to buying and burning PERC?
      </p>
      <p className="mb-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Wallets eligible in the 7 Nov 2026 snapshot can vote. Votes are weighted by snapshot balance; the majority of
        balance voted wins, with no quorum. A tie or no votes means buy and burn. Voting lasts 24 hours and you can
        change your vote until it closes; your last vote counts.
      </p>
      <p className="mb-6 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        You vote by signing a text message with your wallet. It is not a transaction, costs nothing and moves no
        funds. This page never asks for a seed phrase or password.
      </p>
      <VoteClient />
    </section>
  );
}
