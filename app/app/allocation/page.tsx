import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAllocationVoteHost } from "@/lib/allocation-vote/host";

// Direct-URL only: not linked from nav, header, footer or the homepage, and
// not in the sitemap. Allocations are not published, so this page states that
// and offers no checker form.
export const metadata: Metadata = {
  title: "PERC allocation checker",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function AllocationPage() {
  if (!isAllocationVoteHost((await headers()).get("host"))) notFound();
  return (
    <section className="mx-auto max-w-xl px-4 py-20">
      <h1 className="mb-4 text-2xl font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>
        PERC allocation checker
      </h1>
      <p className="mb-2 text-[15px] text-[var(--text)]">Allocations have not been published yet.</p>
      <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
        Nothing can be checked here until a final, approved snapshot export is published.
      </p>
    </section>
  );
}
