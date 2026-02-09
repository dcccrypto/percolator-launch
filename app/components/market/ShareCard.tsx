"use client";

import { FC, useState } from "react";

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
    const text = `Trading ${marketName} perps on Viper 🐍 $${fmtPrice}${changeStr ? ` | ${changeStr}` : ""} | ${tradeUrl}`;
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, "_blank");
  };

  return (
    <div className="rounded-lg border border-white/[0.06] bg-[#0d1117] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-lg font-bold text-white">{marketName}</span>
        <span className="text-xs text-[#5a6382]">PERP</span>
      </div>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-xl text-white">${fmtPrice}</span>
        {change24h != null && (
          <span className={`text-sm font-medium ${change24h >= 0 ? "text-[#00FFB2]" : "text-[#FF4466]"}`}>
            {changeStr}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={copyLink}
          className="flex-1 rounded-md border border-white/[0.08] bg-white/[0.05] px-3 py-1.5 text-xs text-[#c4cbde] transition hover:bg-white/[0.06]"
        >
          {copied ? "Copied ✓" : "Copy Link"}
        </button>
        <button
          onClick={shareOnX}
          className="flex-1 rounded-md bg-[#00FFB2] px-3 py-1.5 text-xs font-medium text-black transition hover:bg-[#00FFB2]/80"
        >
          Share on 𝕏
        </button>
      </div>
    </div>
  );
};

/** Compact share button for the trade page header */
export const ShareButton: FC<Omit<ShareCardProps, "change24h"> & { change24h?: number }> = (props) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="rounded-md border border-white/[0.08] bg-white/[0.05] px-2.5 py-1 text-xs text-[#c4cbde] transition hover:bg-white/[0.06]"
        title="Share"
      >
        ↗ Share
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-64">
            <ShareCard {...props} />
          </div>
        </>
      )}
    </div>
  );
};
