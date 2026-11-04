"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * The waitlist page's "more information" row: a set of tab buttons over ONE panel.
 * Every panel starts closed so the page stays short. Opening a tab closes whichever
 * was open; clicking the open tab again closes it.
 *
 * Built as a disclosure group, not ARIA tabs: the ARIA tab pattern requires one tab
 * to be selected at all times, and here none may be. Each button carries
 * aria-expanded + aria-controls; the panel is a labelled region.
 */

export interface InfoTab {
  id: string;
  label: string;
  content: ReactNode;
}

/** Which tab is open after a click. Pure. */
export function nextOpenTab(open: string | null, clicked: string): string | null {
  return open === clicked ? null : clicked;
}

export function InfoTabs({ tabs }: { tabs: InfoTab[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const baseId = useId();
  const active = tabs.find((t) => t.id === open) ?? null;
  const panelId = `${baseId}-panel`;

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="More about Percolator">
        {tabs.map((t) => {
          const isOpen = t.id === open;
          return (
            <button
              key={t.id}
              id={`${baseId}-${t.id}`}
              type="button"
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpen((o) => nextOpenTab(o, t.id))}
              className={`rounded-md border px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.14em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
                isOpen
                  ? "border-[var(--accent)] bg-[var(--accent)]/[0.12] text-[var(--text)]"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text)]"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Always mounted so aria-controls never points at a missing node. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={active ? `${baseId}-${active.id}` : undefined}
        aria-label={active ? undefined : "More about Percolator"}
        hidden={!active}
        className="mt-5 rounded-md border border-[var(--border)] bg-[var(--panel-bg)] p-5 text-[14px] leading-[1.65] text-[var(--text-secondary)] sm:p-6"
      >
        {active?.content}
      </div>
    </div>
  );
}
