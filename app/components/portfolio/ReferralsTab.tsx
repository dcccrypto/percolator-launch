"use client";

import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { usePrivyBridge } from "@/hooks/usePrivyBridge";
import { useReferrals, type ReferralsState } from "@/hooks/useReferrals";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

const panel = "border border-[var(--border)] bg-[var(--panel-bg)]";
const label = "text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]";
const actionButton =
  "inline-flex min-h-[44px] items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 text-[10px] uppercase tracking-[0.12em] text-[var(--accent-text)] transition-colors hover:bg-[var(--accent)]/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]";

/** The link as shown: without the scheme, so the part that differs (the code) stays visible on phones. */
const displayLink = (link: string): string => link.replace(/^https?:\/\//, "");

const Shell: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="relative min-h-[calc(100dvh-48px)]">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-grid" />
    <main className="relative mx-auto max-w-5xl px-4 py-10">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">// referrals</div>
      <h1 className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
        <span className="font-normal text-[var(--text-muted)]">Your </span>Referrals
      </h1>
      <p className="mb-8 mt-2 text-[13px] text-[var(--text-secondary)]">share your link and see who joined with it.</p>
      {children}
    </main>
  </div>
);

const Notice: FC<{ children: ReactNode }> = ({ children }) => (
  <div className={`${panel} p-10 text-center`}>{children}</div>
);

/**
 * Copy inside the tap itself. `execCommand("copy")` on a selected, off-screen textarea runs synchronously,
 * so it stays within the tap's user gesture (in-app mobile browsers often refuse the async clipboard);
 * the async clipboard is the second try, still started inside the gesture. Focus is handed back after.
 */
function legacyCopy(text: string): boolean {
  const before = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  Object.assign(ta.style, { position: "fixed", top: "-1000px", left: "0", opacity: "0", fontSize: "16px" });
  document.body.appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    before?.focus?.({ preventScroll: true });
  }
}

type CopyState = "idle" | "copied" | "failed";

/** Copies `text`. "Copied" shows for two seconds; "failed" stays until the next try. */
function useCopy(text: string): [CopyState, () => void] {
  const [status, setStatus] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    // Set on every mount, not only at creation: React's development double-mount (and Fast Refresh)
    // runs this cleanup and then mounts again.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const show = (s: CopyState) => {
    if (!mounted.current) return;
    setStatus(s);
    if (timer.current) clearTimeout(timer.current);
    if (s === "copied") timer.current = setTimeout(() => setStatus("idle"), 2000);
  };
  const copy = () => {
    if (legacyCopy(text)) {
      show("copied");
      return;
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => show("copied"),
        () => show("failed"),
      );
    } else {
      show("failed");
    }
  };
  return [status, copy];
}

const LockIcon: FC = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const ReferralDetails: FC<{ code: string; link: string; joined: number | null }> = ({ code, link, joined }) => {
  const [copyStatus, copy] = useCopy(link);
  return (
    <div className="space-y-2">
      <div className={`${panel} p-6 sm:p-8`}>
        <p className={`${label} mb-3`}>Your referral link</p>
        <button
          type="button"
          onClick={copy}
          title="Copy your referral link"
          aria-label={`Copy your referral link ${link}`}
          className="flex min-h-[46px] w-full max-w-2xl items-center justify-between gap-3 border border-[var(--border)] bg-[var(--bg)] px-3 py-3 text-left transition-colors hover:border-[var(--accent)]/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        >
          <span className="min-w-0 truncate font-mono text-[13px] text-[var(--text)]">{displayLink(link)}</span>
          <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--accent-text)]" aria-live="polite">
            {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
          </span>
        </button>
        {copyStatus === "failed" && (
          <label className="mt-3 block max-w-2xl text-[11px] text-[var(--text-secondary)]">
            Copy it from here instead:
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-1 block w-full border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-[16px] text-[var(--text)] sm:text-[13px]"
            />
          </label>
        )}
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          Code <span className="font-mono text-[var(--text-secondary)]">{code}</span>
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className={`${panel} p-6 sm:p-8`}>
          <p className={`${label} mb-2`}>Joined with your link</p>
          <p className="text-3xl font-medium tabular-nums text-[var(--text)]" style={{ fontFamily: "var(--font-display)" }}>
            {joined === null ? "—" : joined.toLocaleString()}
          </p>
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">
            {joined === null ? "Couldn't load this just now. It refreshes when you come back." : "People who signed up using your link."}
          </p>
        </div>

        <div className={`${panel} p-6 sm:p-8`}>
          <p className={`${label} mb-2`}>Rewards</p>
          <p
            className="flex items-center gap-2 text-3xl font-medium text-[var(--text-muted)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            <LockIcon />
            Locked
          </p>
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">Referral rewards will appear here once they unlock.</p>
        </div>
      </div>
    </div>
  );
};

/** The tab for a given state: presentational, so every state can be rendered and checked on its own. */
export const ReferralsView: FC<{ state: ReferralsState; onSignIn: () => void; onRetry: () => void }> = ({
  state,
  onSignIn,
  onRetry,
}) => {
  if (state.status === "loading") {
    return (
      <Shell>
        <div aria-busy="true" className="space-y-2">
          <div className={`${panel} p-6 sm:p-8`}>
            <ShimmerSkeleton className="mb-3 h-3 w-32" />
            <ShimmerSkeleton className="h-[46px] w-full max-w-2xl" />
            <ShimmerSkeleton className="mt-3 h-3 w-24" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className={`${panel} p-6 sm:p-8`}>
                <ShimmerSkeleton className="mb-3 h-3 w-28" />
                <ShimmerSkeleton className="h-9 w-20" />
                <ShimmerSkeleton className="mt-3 h-3 w-40" />
              </div>
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  if (state.status === "signed-out") {
    return (
      <Shell>
        <Notice>
          <p className="mb-4 text-[11px] text-[var(--text-secondary)]">sign in to see your referral link</p>
          <button type="button" onClick={onSignIn} className={actionButton}>
            Sign in
          </button>
        </Notice>
      </Shell>
    );
  }

  if (state.status === "unavailable") {
    return (
      <Shell>
        <Notice>
          <p className="mx-auto mb-4 max-w-md text-[11px] text-[var(--text-secondary)]">
            Your referral link isn&apos;t linked to this login yet. Enter the playground from percolator.trade with the
            account you joined the waitlist with, and it will show here.
          </p>
          <a href={state.enterUrl} className={actionButton}>
            Enter from percolator.trade
          </a>
        </Notice>
      </Shell>
    );
  }

  if (state.status === "error") {
    return (
      <Shell>
        <Notice>
          <p className="mb-4 text-[11px] text-[var(--text-secondary)]">Couldn&apos;t load your referrals just now.</p>
          <button type="button" onClick={onRetry} className={actionButton}>
            Try again
          </button>
        </Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      <ReferralDetails code={state.code} link={state.link} joined={state.joined} />
    </Shell>
  );
};

/** Portfolio > Referrals. */
export const ReferralsTab: FC = () => {
  const { login } = usePrivyBridge();
  const { state, retry } = useReferrals();
  return <ReferralsView state={state} onSignIn={() => login()} onRetry={retry} />;
};

export default ReferralsTab;
