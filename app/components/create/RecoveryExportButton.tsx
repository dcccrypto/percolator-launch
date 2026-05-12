"use client";

import { useState } from "react";
import {
  loadLastInFlightMarket,
  buildRecoveryPayload,
} from "@/lib/inFlightMarket";

/**
 * Downloads the in-flight market state as a JSON file the user (or a teammate)
 * can hand to scripts/close-market-reclaim-all.ts to recover funds if the
 * wizard fails or the tab is closed before the market is fully created.
 *
 * Two buttons:
 *   - "Download recovery JSON" — pubkeys only (safe to share)
 *   - "Download with secret"   — pubkeys + slab keypair secret (sensitive)
 *
 * Both files include a self-explanatory _instructions field that tells the
 * recipient exactly what command to run.
 */
export function RecoveryExportButton({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  const download = (includeSlabSecret: boolean) => {
    setBusy(true);
    try {
      const state = loadLastInFlightMarket();
      if (!state) {
        alert("No in-flight market found. Nothing to export.");
        return;
      }
      const payload = buildRecoveryPayload(state, { includeSlabSecret });
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const slabPrefix = state.slabAddress.slice(0, 8);
      const ts = new Date(state.createdAt)
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const suffix = includeSlabSecret ? "with-secret" : "pubkeys";
      const filename = `percolator-recovery-${slabPrefix}-${ts}-${suffix}.json`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <button
        type="button"
        disabled={busy}
        onClick={() => download(false)}
        className="border border-[var(--border)] bg-transparent px-3 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text)] transition-colors disabled:opacity-50"
        title="Pubkeys only — safe to share. Use with the in-UI recovery banner or the close-market-reclaim-all.ts script (admin-side close)."
      >
        ⬇ DOWNLOAD RECOVERY JSON
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => download(true)}
        className="border border-[var(--warning)]/40 bg-transparent px-3 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--warning)] hover:bg-[var(--warning)]/[0.06] transition-colors disabled:opacity-50"
        title="Includes the slab keypair secret — required only for the slab-side ReclaimSlabRent path. Treat as sensitive."
      >
        ⬇ WITH SLAB SECRET (SENSITIVE)
      </button>
    </div>
  );
}
