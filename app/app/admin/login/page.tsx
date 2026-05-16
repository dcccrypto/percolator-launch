"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";

/**
 * Admin login — delegates to Privy's modal (email + OTP, optional 2FA
 * once enabled in the Privy dashboard). Whether the logged-in user is
 * an admin is decided server-side from PRIVY_ADMIN_EMAILS, so this
 * page just gets them through Privy and bounces them to /admin where
 * the page-level guard does the actual gate.
 */
const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)] p-8";

export default function AdminLoginPage() {
  const router = useRouter();
  const { ready, authenticated, login, user } = usePrivy();

  useEffect(() => {
    if (ready && authenticated) {
      router.replace("/admin");
    }
  }, [ready, authenticated, router]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className={`${card} w-full max-w-sm text-center`}>
          <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
            Loading session...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className={`${card} w-full max-w-sm`}>
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]">
          Percolator
        </div>
        <h1 className="text-xl font-bold text-[var(--text)] mb-6">Admin Login</h1>

        {authenticated ? (
          <div className="space-y-3">
            <p className="text-[13px] text-[var(--text-secondary)]">
              Signed in as{" "}
              <span className="font-mono text-[var(--text)]">
                {user?.email?.address ?? user?.id}
              </span>
            </p>
            <button
              onClick={() => router.replace("/admin")}
              className="block w-full rounded-none border border-[var(--accent)]/60 bg-[var(--accent)]/[0.12] px-4 py-3 text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--text)] transition-colors hover:bg-[var(--accent)]/20"
            >
              Continue to admin &rarr;
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Sign in via Privy. Email + 2FA. Only addresses listed in
              <code className="mx-1 font-mono text-[12px] text-[var(--text)]">
                PRIVY_ADMIN_EMAILS
              </code>
              can reach the dashboard.
            </p>
            <button
              onClick={login}
              className="block w-full rounded-none border border-[var(--accent)]/60 bg-[var(--accent)]/[0.12] px-4 py-3 text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--text)] transition-colors hover:bg-[var(--accent)]/20"
            >
              Sign in with Privy &rarr;
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
