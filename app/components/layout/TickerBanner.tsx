"use client";

import { useEffect, useState } from "react";
import { type Network, getConfig } from "@/lib/config";

const DEVNET_ITEMS = [
  "not real money.",
  "break things. report bugs.",
  "mainnet soon™",
  "don't trust, verify.",
  "devnet — not real money.",
  "permissionless perpetuals.",
  "fully on-chain.",
  "no governance. no gatekeepers.",
  "insurance fund on every market.",
  "burn the admin key.",
  "deploy in 60 seconds.",
];

const MAINNET_ITEMS = [
  "permissionless perpetuals.",
  "fully on-chain.",
  "no governance. no gatekeepers.",
  "insurance fund on every market.",
  "deploy in 60 seconds.",
  "up to 20x leverage.",
  "any SPL token.",
  "don't trust, verify.",
  "burn the admin key.",
  "trade anything. permissionlessly.",
];

function TickerContent({ items, colorClass, dotClass }: { items: string[]; colorClass: string; dotClass: string }) {
  return (
    <>
      {items.map((text, i) => (
        <span
          key={i}
          className={`shrink-0 px-8 text-[10px] font-medium uppercase tracking-[0.15em] ${colorClass}`}
        >
          {text}
          <span className={`ml-8 ${dotClass}`}>·</span>
        </span>
      ))}
    </>
  );
}

export function TickerBanner() {
  const [network, setNetwork] = useState<Network>("devnet");
  useEffect(() => { setNetwork(getConfig().network); }, []);

  const isMainnet = network === "mainnet";
  const items = isMainnet ? MAINNET_ITEMS : DEVNET_ITEMS;
  const borderClass = isMainnet ? "border-[var(--accent)]/15" : "border-[var(--warning)]/15";
  const bgClass = isMainnet ? "bg-[var(--accent)]/[0.03]" : "bg-[var(--warning)]/[0.03]";
  const colorClass = isMainnet ? "text-[var(--accent)]/70" : "text-[var(--warning)]/70";
  const dotClass = isMainnet ? "text-[var(--accent)]/20" : "text-[var(--warning)]/20";

  return (
    <div className={`ticker-banner relative z-50 overflow-hidden border-b ${borderClass} ${bgClass}`}>
      <div className="ticker-track inline-flex">
        <TickerContent items={items} colorClass={colorClass} dotClass={dotClass} />
        <TickerContent items={items} colorClass={colorClass} dotClass={dotClass} />
      </div>
    </div>
  );
}
