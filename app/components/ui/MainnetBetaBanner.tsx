"use client";

import { useState, useEffect } from "react";
import { getNetwork } from "@/lib/config";

const DISMISSED_KEY = "mainnet-beta-dismissed";

export function MainnetBetaBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (getNetwork() !== "mainnet") return;
    try {
      if (localStorage.getItem(DISMISSED_KEY)) return;
    } catch {
      // localStorage unavailable
    }
    setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div className="relative z-50 flex items-center justify-center gap-2 bg-amber-500/90 px-4 py-2 text-center text-xs font-medium text-black">
      <span>
        ⚠️ Mainnet Beta — Use at your own risk. Position limits and leverage
        restrictions apply.
      </span>
      <button
        onClick={() => {
          setVisible(false);
          try {
            localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            // localStorage unavailable
          }
        }}
        className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black/70 transition-colors hover:bg-black/10 hover:text-black"
        aria-label="Dismiss banner"
      >
        ✕
      </button>
    </div>
  );
}
