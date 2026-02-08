"use client";

import { FC, useEffect, useState, useMemo, useRef } from "react";

interface PricePoint {
  price_e6: number;
  timestamp: number;
  created_at: string;
}

export const PriceChart: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fetch(`/api/markets/${slabAddress}/prices?since=${since}&limit=500`)
      .then((r) => r.json())
      .then((d) => {
        setPrices((d.prices ?? []).reverse()); // ascending order
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slabAddress]);

  const { points, minP, maxP, curPrice, high, low, isUp, minT, maxT } = useMemo(() => {
    if (prices.length === 0)
      return { points: "", minP: 0, maxP: 0, curPrice: 0, high: 0, low: 0, isUp: true, minT: 0, maxT: 0 };

    const vals = prices.map((p) => p.price_e6 / 1e6);
    const times = prices.map((p) => p.timestamp);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const range = mx - mn || 1;
    const tRange = tMax - tMin || 1;

    const W = 600;
    const H = 160;
    const pad = { top: 10, bottom: 30, left: 0, right: 0 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    const pts = prices
      .map((p, i) => {
        const x = pad.left + ((times[i] - tMin) / tRange) * chartW;
        const y = pad.top + (1 - (vals[i] - mn) / range) * chartH;
        return `${x},${y}`;
      })
      .join(" ");

    return {
      points: pts,
      minP: mn,
      maxP: mx,
      curPrice: vals[vals.length - 1],
      high: mx,
      low: mn,
      isUp: vals[vals.length - 1] >= vals[0],
      minT: tMin,
      maxT: tMax,
    };
  }, [prices]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || prices.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(Math.max(Math.round(x * (prices.length - 1)), 0), prices.length - 1);
    setHoveredIdx(idx);
  };

  if (loading) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-lg border border-zinc-800 bg-[#0d1117]">
        <div className="text-sm text-slate-500">Loading chart…</div>
      </div>
    );
  }

  if (prices.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-lg border border-zinc-800 bg-[#0d1117]">
        <div className="text-sm text-slate-500">No price history yet</div>
      </div>
    );
  }

  const color = isUp ? "#10b981" : "#ef4444";
  const hoveredPrice = hoveredIdx !== null ? prices[hoveredIdx].price_e6 / 1e6 : null;
  const hoveredTime = hoveredIdx !== null ? new Date(prices[hoveredIdx].timestamp * 1000) : null;

  const fmtPrice = (p: number) => (p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2));

  // Time axis labels
  const timeLabels = useMemo(() => {
    if (minT === maxT) return [];
    const labels: { x: number; label: string }[] = [];
    const count = 5;
    for (let i = 0; i <= count; i++) {
      const t = minT + ((maxT - minT) * i) / count;
      const d = new Date(t * 1000);
      labels.push({
        x: (i / count) * 100,
        label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
    }
    return labels;
  }, [minT, maxT]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-[#0d1117] p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-slate-400">24h Price</span>
        <div className="flex gap-3">
          <span className="text-slate-500">
            H: <span className="text-white">${fmtPrice(high)}</span>
          </span>
          <span className="text-slate-500">
            L: <span className="text-white">${fmtPrice(low)}</span>
          </span>
          <span style={{ color }}>
            ${fmtPrice(hoveredPrice ?? curPrice)}
          </span>
        </div>
      </div>
      {hoveredTime && (
        <div className="mb-1 text-right text-[10px] text-slate-500">
          {hoveredTime.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox="0 0 600 160"
        className="w-full"
        style={{ height: 160 }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredIdx(null)}
      >
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <polygon
          points={`${points} 600,130 0,130`}
          fill="url(#chartGrad)"
        />
        {/* Line */}
        <polyline points={points} fill="none" stroke={color} strokeWidth="2" />
        {/* Current price dot */}
        {prices.length > 0 && (() => {
          const lastPts = points.split(" ");
          const last = lastPts[lastPts.length - 1];
          const [cx, cy] = last.split(",");
          return <circle cx={cx} cy={cy} r="3" fill={color} />;
        })()}
      </svg>
      {/* Time axis */}
      <div className="relative mt-1 flex justify-between text-[10px] text-slate-600">
        {timeLabels.map((tl, i) => (
          <span key={i}>{tl.label}</span>
        ))}
      </div>
    </div>
  );
};
