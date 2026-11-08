import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAllocationVoteHost } from "@/lib/allocation-vote/host";
import { AdminStart } from "./AdminStart";

// Holds no secret and grants nothing by itself: the start request is refused
// server-side unless it carries the server-only admin secret.
export const metadata: Metadata = {
  title: "PERC vote admin",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function VoteAdminPage() {
  if (!isAllocationVoteHost((await headers()).get("host"))) notFound();
  return (
    <section className="mx-auto max-w-xl px-4 py-16 sm:py-20">
      <h1 className="mb-4 text-2xl font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>
        Start the PERC holder vote
      </h1>
      <p className="mb-6 text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Starting opens a single 24 hour voting window immediately. It cannot be undone, paused, extended or restarted.
      </p>
      <AdminStart />
    </section>
  );
}
