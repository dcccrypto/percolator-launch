import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isAllocationVoteHost } from "@/lib/allocation-vote/host";
import { ALLOCATION_COPY } from "@/lib/allocation-vote/copy";
import { AllocationChecker } from "./AllocationChecker";

// Direct-URL only: not linked from nav, header, footer or the homepage, and
// not in the sitemap. The page carries no holder data: the form asks the
// server about one pasted wallet at a time.
export const metadata: Metadata = {
  title: "PERC allocation checker",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

export const dynamic = "force-dynamic";

export default async function AllocationPage() {
  if (!isAllocationVoteHost((await headers()).get("host"))) notFound();
  return (
    <section className="mx-auto max-w-xl px-4 py-16 sm:py-20">
      <h1 className="mb-4 text-2xl font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>
        {ALLOCATION_COPY.title}
      </h1>
      {ALLOCATION_COPY.terms.map((t) => (
        <p key={t} className="mb-2 text-[15px] leading-relaxed text-[var(--text)]">
          {t}
        </p>
      ))}
      <p className="mb-6 mt-4 text-[13px] leading-relaxed text-[var(--text-secondary)]">{ALLOCATION_COPY.instructions}</p>
      <AllocationChecker />
    </section>
  );
}
