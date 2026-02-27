"use client";

import { useEffect, useRef, useState, useCallback } from "react";

/** Generate a seeded random-walk price series */
function generatePriceSeries(length: number, seed: number, base: number): number[] {
  let val = base;
  const pts: number[] = [val];
  let s = seed;
  for (let i = 1; i < length; i++) {
    s = (s * 16807 + 0) % 2147483647;
    const r = (s / 2147483647 - 0.5) * base * 0.02;
    val = Math.max(base * 0.9, Math.min(base * 1.1, val + r));
    pts.push(val);
  }
  return pts;
}

interface MiniSparklineProps {
  width?: number;
  height?: number;
  basePrice?: number;
  className?: string;
}

export function MiniSparkline({
  width = 340,
  height = 120,
  basePrice = 185.4,
  className = "",
}: MiniSparklineProps) {
  const [prices, setPrices] = useState<number[]>(() =>
    generatePriceSeries(48, 42, basePrice)
  );
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const addPoint = useCallback(() => {
    setPrices((prev) => {
      const last = prev[prev.length - 1];
      const delta = (Math.random() - 0.48) * basePrice * 0.008;
      const next = Math.max(basePrice * 0.9, Math.min(basePrice * 1.1, last + delta));
      return [...prev.slice(-59), next];
    });
  }, [basePrice]);

  useEffect(() => {
    intervalRef.current = setInterval(addPoint, 3000);
    return () => clearInterval(intervalRef.current);
  }, [addPoint]);

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const padY = 8;
  const usableH = height - padY * 2;

  const points = prices
    .map((p, i) => {
      const x = (i / (prices.length - 1)) * width;
      const y = padY + usableH - ((p - min) / range) * usableH;
      return `${x},${y}`;
    })
    .join(" ");

  const areaPoints = `0,${height} ${points} ${width},${height}`;
  const currentPrice = prices[prices.length - 1];

  return (
    <div className={className}>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className="text-[28px] font-semibold tracking-tight text-white"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          ${currentPrice.toFixed(2)}
        </span>
        <span className={`text-xs ${currentPrice >= basePrice ? "text-green-400" : "text-red-400"}`}>
          {currentPrice >= basePrice ? "+" : ""}{((currentPrice / basePrice - 1) * 100).toFixed(2)}%
        </span>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(124,58,237)" stopOpacity="0.15" />
            <stop offset="100%" stopColor="rgb(124,58,237)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={areaPoints} fill="url(#sparkFill)" />
        <polyline
          points={points}
          fill="none"
          stroke="rgb(124,58,237)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
