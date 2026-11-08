"use client";

import { useState, type FormEvent } from "react";
import { START_CONFIRMATION } from "@/lib/allocation-vote/vote-message";

/** The secret lives only in this input's state: never stored, logged or put in a URL. */
export function AdminStart() {
  const [secret, setSecret] = useState("");
  const [sure, setSure] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!sure || !secret || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/vote/admin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ confirm: START_CONFIRMATION }),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const b = await r.json().catch(() => null);
      if (r.status === 200 && b?.status === "started") setMsg(`Vote started. Closes ${b.ends_at}.`);
      else if (b?.status === "already_started") setMsg(`Already started. Closes ${b.ends_at}. It cannot be restarted.`);
      else if (r.status === 429) setMsg("Too many attempts. Try again later.");
      else if (r.status === 401) setMsg("Not authorized.");
      else if (r.status === 404) setMsg("Admin start is not enabled on this deployment.");
      else setMsg(b?.error ?? "Could not start the vote.");
    } catch {
      setMsg("Network error.");
    } finally {
      setSecret("");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <label htmlFor="vote-admin-secret" className="text-[14px] text-[var(--text)]">
        Admin secret
      </label>
      <input
        id="vote-admin-secret"
        type="password"
        autoComplete="off"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        className="rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-[14px] text-[var(--text)]"
      />
      <label className="flex items-center gap-2 text-[14px] text-[var(--text)]">
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        I understand this opens the 24 hour vote now and cannot be undone.
      </label>
      <button
        type="submit"
        disabled={!sure || !secret || busy}
        className="rounded border border-[var(--border)] px-4 py-2 text-[14px] font-semibold text-[var(--text)] disabled:opacity-50"
      >
        Start vote
      </button>
      <p aria-live="polite" className="text-[14px] text-[var(--text)]">{msg}</p>
    </form>
  );
}
