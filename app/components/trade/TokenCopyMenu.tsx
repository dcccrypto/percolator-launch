"use client";

import { FC, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { baseSymbol } from "@/lib/symbol-utils";

/** X's live search for `q`. */
export const xSearchUrl = (q: string): string => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;

const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;

const ITEM =
  "flex w-full items-center gap-2 whitespace-nowrap rounded-sm px-3 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.06] hover:text-[var(--text)]";

type Copied = "Slab address" | "CA" | "Ticker";

const PANEL_MIN_W = 220;

/** Where the menu (and the note) sit: under the trigger, left-aligned to it. */
type Anchor = { top: number; left: number };

/**
 * Trade header "Copy address" menu: the market's slab address, the token's CA (its mainnet
 * contract address, what traders paste into other tools) and ticker, and X searches for the CA
 * and $ticker. Sits after the market name; below md the button is the glyph alone.
 *
 * The menu and the "copied" note are portaled and placed from the trigger's rect: the info bar is
 * an overflow-x-auto scroll container with backdrop-blur, which clips absolute and fixed children
 * alike (same reason as MarketSwitcher, #2268).
 */
export const TokenCopyMenu: FC<{
  slabAddress: string;
  symbol: string;
  mainnetCa?: string | null;
}> = ({ slabAddress, symbol, mainnetCa }) => {
  const [pos, setPos] = useState<Anchor | null>(null);
  const open = pos !== null;
  const [copied, setCopied] = useState<({ what: Copied } & Anchor) | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const anchor = (): Anchor | null => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return null;
    return { top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - PANEL_MIN_W - 8)) };
  };
  const setOpen = (v: boolean) => setPos(v ? anchor() : null);
  const ticker = baseSymbol(symbol);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = (what: Copied, text: string) => {
    const at = anchor();
    void navigator.clipboard?.writeText(text).then(() => at && setCopied({ what, ...at }), () => {});
    setOpen(false);
  };
  const search = (q: string) => {
    window.open(xSearchUrl(q), "_blank", "noopener,noreferrer");
    setOpen(false);
  };

  const copyRows: { what: Copied; value: string; shown: string }[] = [
    { what: "Slab address", value: slabAddress, shown: short(slabAddress) },
    ...(mainnetCa ? [{ what: "CA" as const, value: mainnetCa, shown: short(mainnetCa) }] : []),
    { what: "Ticker", value: ticker, shown: ticker },
  ];

  return (
    <div ref={ref} className="relative shrink-0" data-testid="token-copy">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Copy address"
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          "inline-flex min-h-[24px] min-w-[24px] select-none items-center justify-center gap-1.5 border px-1 md:px-2 border-[var(--text-secondary)]/40 text-[9px] font-medium uppercase tracking-wider text-[var(--text-secondary)] transition-colors hover:border-[var(--accent-text)] hover:text-[var(--accent-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
          open ? "border-[var(--accent-text)] text-[var(--accent-text)]" : "",
        ].join(" ")}
      >
        <CopyIcon />
        <span className="hidden md:inline">Copy address</span>
      </button>
      {pos && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          role="menu"
          className="fixed z-50 rounded-md border border-[var(--border)] bg-[var(--bg)] p-1 shadow-lg"
          style={{ ...pos, minWidth: PANEL_MIN_W }}
        >
          {copyRows.map((r) => (
            <button key={r.what} type="button" role="menuitem" aria-label={`Copy ${r.what}`} className={ITEM} onClick={() => copy(r.what, r.value)}>
              <CopyIcon />
              <span>{r.what}</span>
              <span className="ml-auto pl-4 font-mono text-[11px] text-[var(--text-muted)]">{r.shown}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-[var(--border)]" />
          {mainnetCa && (
            <button type="button" role="menuitem" className={ITEM} onClick={() => search(mainnetCa)}>
              <XIcon />
              Search CA on X
            </button>
          )}
          <button type="button" role="menuitem" className={ITEM} onClick={() => search(`$${ticker}`)}>
            <XIcon />
            Search ${ticker} on X
          </button>
        </div>,
        document.body,
      )}
      {copied && typeof document !== "undefined" && createPortal(
        <span
          role="status"
          className="pointer-events-none fixed z-50 text-[10px]"
          style={{ top: copied.top, left: copied.left }}
        >
          <span className="whitespace-nowrap rounded-sm border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-[var(--text-secondary)]">
            {copied.what} copied
          </span>
        </span>,
        document.body,
      )}
    </div>
  );
};

const CopyIcon: FC = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="5" y="5" width="8.5" height="8.5" rx="1" />
    <path d="M10.5 5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H5" />
  </svg>
);

const XIcon: FC = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3 w-3 shrink-0 fill-current">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);
