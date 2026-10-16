"use client";

/**
 * v2.2 QA NB-2: the visible debug line for lib/v22/sign-guard.ts. Shows the last signature request that the guard
 * refused or reported, or that the wallet declined, with the path that built the transaction. Renders nothing until
 * then, and nothing at all when the v2.2 flag is off. QA instrumentation for the preview only; hidden unless `?signdebug=1` (stored in localStorage `v22.signdebug`).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { dismissSignProblem, formatSignEntry, isSignDebugEnabled, lastSignProblem, subscribeSignGuard } from "@/lib/v22/sign-guard";

export function SignGuardLine() {
  const req = useSyncExternalStore(subscribeSignGuard, lastSignProblem, () => null);
  // Opt-in only (?signdebug=1): ordinary users never see it. The data stays in window.__v22SignLog either way.
  const [optIn, setOptIn] = useState(false);
  useEffect(() => setOptIn(isSignDebugEnabled()), []);
  if (!isDevnetV22Enabled() || !optIn || !req) return null;
  return (
    <div
      role="status"
      data-testid="v22-sign-guard-line"
      className="fixed inset-x-0 bottom-0 z-[1000] flex items-start gap-2 border-t border-yellow-500/40 bg-black/90 px-3 py-1.5 font-mono text-[11px] leading-snug text-yellow-200"
    >
      <span className="min-w-0 flex-1 break-words">sign debug: {formatSignEntry(req)}{req.walletError ? ` | ${req.walletError}` : ""}</span>
      <button type="button" onClick={dismissSignProblem} className="shrink-0 underline" aria-label="Dismiss sign debug line">
        dismiss
      </button>
    </div>
  );
}
