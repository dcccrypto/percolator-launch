"use client";

import { FC, useState, useRef, useEffect } from "react";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface ShareCardProps {
  slabAddress: string;
  marketName: string;
  price: bigint;
  change24h?: number;
}

const DOMAIN = "percolatorlaunch.com";

function buildTradeUrl(slab: string) {
  return `https://${DOMAIN}/trade/${slab}`;
}

function buildXShareText(marketName: string, fmtPrice: string, changeStr: string, tradeUrl: string) {
  const lines = [
    `Just opened a position on $${marketName} perps at $${fmtPrice}${changeStr ? ` (${changeStr})` : ""}`,
    "",
    `Trade it yourself on`,
    tradeUrl,
  ];
  return lines.join("\n");
}

export const ShareCard: FC<ShareCardProps> = ({ slabAddress, marketName, price, change24h }) => {
  const [copied, setCopied] = useState(false);

  const priceNum = Number(price) / 1e6;
  const fmtPrice = priceNum < 0.01 ? priceNum.toFixed(6) : priceNum < 1 ? priceNum.toFixed(4) : priceNum.toFixed(2);
  const changeStr = change24h != null ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "";
  const tradeUrl = buildTradeUrl(slabAddress);

  const copyLink = async () => {
    await navigator.clipboard.writeText(tradeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shareOnX = () => {
    const text = buildXShareText(marketName, fmtPrice, changeStr, tradeUrl);
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
  };

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>{marketName}</span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">PERP</span>
      </div>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>${fmtPrice}</span>
        {change24h != null && (
          <span className={`text-xs font-medium ${change24h >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {changeStr}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={copyLink}
          className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-all duration-150 hover:border-[var(--accent)]/30 hover:text-[var(--text)] active:scale-[0.98]"
        >
          {copied ? "Copied" : "Copy Link"}
        </button>
        <button
          onClick={shareOnX}
          className="flex-1 rounded-sm border border-[var(--accent)]/40 bg-transparent px-3 py-1.5 text-xs font-semibold text-[var(--accent)] transition-all duration-150 hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08] active:scale-[0.98]"
        >
          Share on X
        </button>
      </div>
    </div>
  );
};

/** Compact share button for the trade page header */
export const ShareButton: FC<Omit<ShareCardProps, "change24h"> & { change24h?: number }> = (props) => {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    if (open && dropdownRef.current && !prefersReduced) {
      gsap.fromTo(
        dropdownRef.current,
        { scale: 0.95, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.2, ease: "power2.out" },
      );
    }
  }, [open, prefersReduced]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] transition-all duration-150 hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
        title="Share"
      >
        Share
      </button>
      {open && (
        <div ref={dropdownRef} className="fixed sm:absolute right-4 sm:right-0 top-auto sm:top-full z-50 mt-2 w-[calc(100vw-2rem)] sm:w-72">
          <ShareCard {...props} />
        </div>
      )}
    </div>
  );
};
