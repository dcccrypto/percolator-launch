"use client";

import { useEffect, useState, useRef } from "react";

interface Level {
  price: string;
  width: number;
}

function randomLevels(base: number, side: "buy" | "sell", count: number): Level[] {
  return Array.from({ length: count }, (_, i) => {
    const offset = (i + 1) * 0.05;
    const price = side === "sell" ? base + offset : base - offset;
    const width = 20 + Math.random() * 60;
    return { price: price.toFixed(2), width };
  });
}

export function MiniOrderBook({ className = "" }: { className?: string }) {
  const basePrice = 185.4;
  const [sells, setSells] = useState<Level[]>(() =>
    randomLevels(basePrice, "sell", 3)
  );
  const [buys, setBuys] = useState<Level[]>(() =>
    randomLevels(basePrice, "buy", 3)
  );
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSells(randomLevels(basePrice, "sell", 3));
      setBuys(randomLevels(basePrice, "buy", 3));
    }, 2000);
    return () => clearInterval(intervalRef.current);
  }, []);

  return (
    <div
      className={`font-mono text-[11px] leading-relaxed ${className}`}
      style={{ fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)", fontVariantNumeric: "tabular-nums" }}
    >
      {[...sells].reverse().map((l, i) => (
        <div key={`s-${i}`} className="relative flex items-center justify-between py-0.5">
          <div
            className="absolute inset-y-0 right-0 bg-[var(--short)]/15 transition-all duration-500"
            style={{ width: `${l.width}%` }}
          />
          <span className="relative z-10 text-[var(--text-muted)]">SELL</span>
          <span className="relative z-10 text-[var(--short)]/80">{l.price}</span>
        </div>
      ))}
      <div className="my-1 flex items-center gap-2 text-[var(--text-muted)]">
        <span className="h-px flex-1 bg-[var(--border)]" />
        <span className="text-[10px]">{basePrice.toFixed(2)}</span>
        <span className="h-px flex-1 bg-[var(--border)]" />
      </div>
      {buys.map((l, i) => (
        <div key={`b-${i}`} className="relative flex items-center justify-between py-0.5">
          <div
            className="absolute inset-y-0 right-0 bg-[var(--long)]/15 transition-all duration-500"
            style={{ width: `${l.width}%` }}
          />
          <span className="relative z-10 text-[var(--text-muted)]">BUY</span>
          <span className="relative z-10 text-[var(--long)]/80">{l.price}</span>
        </div>
      ))}
    </div>
  );
}
