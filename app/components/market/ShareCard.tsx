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
    <div className="rounded-lg border border-zinc-800 bg-[#0d1117] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-lg font-bold text-white">{marketName}</span>
        <span className="text-xs text-slate-500">PERP</span>
      </div>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="font-mono text-xl text-white">${fmtPrice}</span>
        {change24h != null && (
          <span className={`text-sm font-medium ${change24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {changeStr}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={copyLink}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-zinc-700"
        >
          {copied ? "Copied ✓" : "Copy Link"}
        </button>
        <button
          onClick={shareOnX}
          className="flex-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black transition hover:bg-slate-200"
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
        className="rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-zinc-700"
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
