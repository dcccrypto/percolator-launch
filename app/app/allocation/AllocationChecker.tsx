"use client";

import { useRef, useState, type FormEvent } from "react";
import type { CheckBody } from "@/lib/allocation-vote/check-result";
import { ALLOCATION_COPY } from "@/lib/allocation-vote/copy";

type View = { kind: "idle" } | { kind: "loading" } | { kind: "result"; body: CheckBody } | { kind: "error"; message: string };

const group = (int: string) => int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** Groups the integer part of an exact decimal string; no float conversion. */
function grouped(dec: string): string {
  const [i, f] = dec.split(".");
  return f ? `${group(i!)}.${f}` : group(i!);
}

function ResultView({ body }: { body: CheckBody }) {
  switch (body.status) {
    case "eligible":
      return (
        <div data-testid="alloc-result" data-status="eligible">
          <p className="mb-3 text-[15px] font-semibold text-[var(--text)]">Eligible</p>
          <dl className="grid grid-cols-1 gap-y-1 text-[14px] sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-[var(--text-secondary)]" data-testid="alloc-balance-label">
              {body.balance_basis === "exception" ? `${ALLOCATION_COPY.exceptionBalanceLabel}` : `Snapshot balance (${body.snapshot})`}
            </dt>
            <dd className="break-all font-mono text-[var(--text)]" data-testid="alloc-balance">
              {grouped(body.snapshot_balance)} PERC
            </dd>
            <dt className="text-[var(--text-secondary)]">Provisional allocation</dt>
            <dd className="font-mono text-[var(--text)]" data-testid="alloc-usd">
              ${grouped(body.provisional_allocation_usd)}
            </dd>
          </dl>
          <p className="mt-3 text-[12px] text-[var(--text-secondary)]">{ALLOCATION_COPY.provisionalNote}</p>
        </div>
      );
    case "excluded":
      return (
        <div data-testid="alloc-result" data-status="excluded">
          <p className="mb-3 text-[15px] font-semibold text-[var(--text)]">Not eligible</p>
          <dl className="grid grid-cols-1 gap-y-1 text-[14px] sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-[var(--text-secondary)]">Snapshot balance ({body.snapshot})</dt>
            <dd className="break-all font-mono text-[var(--text)]" data-testid="alloc-balance">
              {grouped(body.snapshot_balance)} PERC
            </dd>
            <dt className="text-[var(--text-secondary)]">Reason</dt>
            <dd className="text-[var(--text)]" data-testid="alloc-reasons">
              <ul>
                {body.exclusion_reasons.map((r) => (
                  <li key={r.code}>{r.label}</li>
                ))}
              </ul>
            </dd>
          </dl>
        </div>
      );
    case "not_found":
      return (
        <p data-testid="alloc-result" data-status="not_found" className="text-[14px] text-[var(--text)]">
          This wallet is not in the {body.snapshot} snapshot.
        </p>
      );
    case "rate_limited":
      return (
        <p data-testid="alloc-result" data-status="rate_limited" role="alert" className="text-[14px] text-[var(--text)]">
          Too many checks. Try again in {body.retry_after_seconds} seconds.
        </p>
      );
    case "invalid":
      return (
        <p data-testid="alloc-result" data-status="invalid" role="alert" className="text-[14px] text-[var(--text)]">
          {body.error}
        </p>
      );
    default:
      return (
        <p data-testid="alloc-result" data-status="unavailable" role="alert" className="text-[14px] text-[var(--text)]">
          Allocation checker unavailable. Try again later.
        </p>
      );
  }
}

export function AllocationChecker() {
  const [wallet, setWallet] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  // Guards against an older response overwriting the result for a newer input.
  const seq = useRef(0);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const n = ++seq.current;
    setView({ kind: "loading" });
    try {
      const res = await fetch("/api/allocation/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet }),
        cache: "no-store",
        credentials: "omit",
      });
      const body = (await res.json().catch(() => null)) as CheckBody | null;
      if (n !== seq.current) return;
      setView(body && typeof body.status === "string" ? { kind: "result", body } : { kind: "error", message: "Allocation checker unavailable. Try again later." });
    } catch {
      if (n === seq.current) setView({ kind: "error", message: "Network error. Try again." });
    }
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row" noValidate>
        <label htmlFor="alloc-wallet" className="sr-only">
          Wallet address
        </label>
        <input
          id="alloc-wallet"
          name="wallet"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={64}
          placeholder="Solana wallet address"
          value={wallet}
          onChange={(e) => {
            setWallet(e.target.value);
            // Never leave one wallet's result on screen next to another address.
            seq.current++;
            setView({ kind: "idle" });
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-[14px] text-[var(--text)]"
        />
        <button
          type="submit"
          disabled={view.kind === "loading" || wallet.trim() === ""}
          className="rounded border border-[var(--border)] px-4 py-2 text-[14px] font-semibold text-[var(--text)] disabled:opacity-50"
        >
          {view.kind === "loading" ? "Checking" : "Check"}
        </button>
      </form>
      <div aria-live="polite" className="mt-6">
        {view.kind === "result" && <ResultView body={view.body} />}
        {view.kind === "error" && (
          <p data-testid="alloc-result" data-status="error" role="alert" className="text-[14px] text-[var(--text)]">
            {view.message}
          </p>
        )}
      </div>
    </div>
  );
}
