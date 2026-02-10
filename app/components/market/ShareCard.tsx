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

export const ShareCard: FC<ShareCardProps> = ({ slabAddress, marketName, price, change24h }) => {
  const [copied, setCopied] = useState(false);

  const priceNum = Number(price) / 1e6;
  const fmtPrice = priceNum < 0.01 ? priceNum.toFixed(6) : priceNum < 1 ? priceNum.toFixed(4) : priceNum.toFixed(2);
  const changeStr = change24h != null ? `${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%` : "";
  const tradeUrl = `https://percolator-launch.vercel.app/trade/${slabAddress}`;

  const copyLink = async () => {
    await navigator.clipboard.writeText(tradeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shareOnX = () => {
    const text = `Trading ${marketName} perps on Viper $${fmtPrice}${changeStr ? ` | ${changeStr}` : ""} | ${tradeUrl}`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
  };

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-lg font-bold text-white">{marketName}</span>
        <span className="text-xs text-[var(--text-muted)]">PERP</span>
      </div>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-xl text-white">${fmtPrice}</span>
        {change24h != null && (
          <span className={`text-sm font-medium ${change24h >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}`}>
            {changeStr}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={copyLink}
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-transform hover:bg-[var(--border)] hover:scale-[1.02] active:scale-[0.98]"
        >
          {copied ? "Copied" : "Copy Link"}
        </button>
        <button
          onClick={shareOnX}
          className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-transform hover:bg-[var(--accent)]/80 hover:scale-[1.02] active:scale-[0.98]"
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

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--border)]"
        title="Share"
      >
        Share
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div ref={dropdownRef} className="absolute right-0 top-full z-50 mt-1 w-64">
            <ShareCard {...props} />
          </div>
        </>
      )}
    </div>
  );
};
