import type { Metadata } from "next";
import { cohortCutoff } from "@/lib/playground-access";

/**
 * /locked — where the devnet v2 waitlist gate (middleware.ts, PLAYGROUND_GATE_ENABLED)
 * sends anyone without a playground session. Deliberately static and self-contained:
 * no app chrome (ChromeGate hides it), no data fetches, nothing behind the lock.
 */

export const metadata: Metadata = {
  title: "Devnet v2 — waitlist access",
  description: "Devnet v2 is open to the Percolator waitlist.",
  robots: { index: false, follow: false },
};

/** At or above this cutoff the cohort is the whole waitlist, so the page says so instead of a number. */
const OPEN_TO_ALL_CUTOFF = 100_000;

/** Where members prove their spot (percolator.trade, branch `main`, #2732). */
const CHECK_SPOT_URL = "https://percolator.trade/playground";
const WAITLIST_URL = "https://percolator.trade/waitlist";

export default function LockedPage() {
  const cutoff = cohortCutoff();
  const headline =
    cutoff >= OPEN_TO_ALL_CUTOFF
      ? "Devnet v2 is open to everyone on the waitlist."
      : `Devnet v2 is open to the first ${cutoff.toLocaleString("en-US")} on the waitlist.`;
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center px-4">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" aria-hidden="true" />
      <section
        aria-labelledby="locked-title"
        className="relative w-full max-w-md border border-[var(--border)] bg-[var(--panel-bg)] px-6 py-10 text-center sm:px-10"
      >
        <p className="mb-6 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Percolator · Devnet v2
        </p>

        <div
          className="mx-auto mb-6 flex h-11 w-11 items-center justify-center border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]"
          aria-hidden="true"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="1.75">
            <rect x="5" y="11" width="14" height="9" rx="1" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>

        <h1
          id="locked-title"
          className="mb-3 text-xl font-semibold leading-snug text-[var(--text)] sm:text-2xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {headline}
        </h1>

        <p className="mb-8 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          Sign in on percolator.trade with the wallet or email you joined with. If you&apos;re in, you&apos;ll come
          straight back here.
        </p>

        <div className="flex flex-col gap-3">
          <a
            href={CHECK_SPOT_URL}
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--accent-text)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
          >
            Check my spot
          </a>
          <a
            href={WAITLIST_URL}
            className="border border-[var(--border)] px-6 py-3 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text)]"
          >
            Join the waitlist
          </a>
        </div>
      </section>
    </div>
  );
}
