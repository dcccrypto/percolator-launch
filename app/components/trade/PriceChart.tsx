"use client";

import { FC, useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface PricePoint {
  price_e6: number;
  timestamp: number;
}

export const PriceChart: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { config, engine } = useSlabState();
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [hoverState, setHoverState] = useState<{ idx: number; mouseX: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const polylineRef = useRef<SVGPolylineElement>(null);
  const polygonRef = useRef<SVGPolygonElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  // Accumulate prices from on-chain slab state (polled every 3s by SlabProvider)
  const lastPriceRef = useRef<number>(0);
  useEffect(() => {
    if (!config) return;
    const priceE6 = Number(config.authorityPriceE6 ?? config.lastEffectivePriceE6 ?? 0);
    if (priceE6 === 0 || priceE6 === lastPriceRef.current) return;
    lastPriceRef.current = priceE6;
    const now = Math.floor(Date.now() / 1000);
    setPrices(prev => {
      const next = [...prev, { price_e6: priceE6, timestamp: now }];
      // Keep last 500 points
      return next.slice(-500);
    });
  }, [config]);

  // Load price history from API
  useEffect(() => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    fetch(`/api/markets/${slabAddress}/prices?since=${since}&limit=500`)
      .then((r) => r.json())
      .then((d) => {
        const apiPrices = (d.prices ?? []).reverse().map((p: { price_e6: number; timestamp: number }) => ({
          price_e6: p.price_e6,
          timestamp: p.timestamp,
        }));
        if (apiPrices.length > 0) {
          setPrices(prev => {
            // Merge API + live, deduplicate by timestamp
            const merged = [...apiPrices, ...prev];
            const seen = new Set<number>();
            return merged.filter(p => {
              if (seen.has(p.timestamp)) return false;
              seen.add(p.timestamp);
              return true;
            }).sort((a, b) => a.timestamp - b.timestamp).slice(-500);
          });
        }
      })
      .catch(() => {});
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
    const range = mx - mn || 0.001;  // Small range for flat prices
    const tRange = tMax - tMin || 1;

    const W = 600;
    const H = 160;
    const pad = { top: 10, bottom: 30, left: 55, right: 0 };
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

  // Line draw animation via GSAP stroke-dashoffset
  useEffect(() => {
    const line = polylineRef.current;
    const fill = polygonRef.current;
    if (!line || !fill || !points) return;

    if (prefersReduced) {
      // No animation: show everything immediately
      line.style.strokeDasharray = "none";
      line.style.strokeDashoffset = "0";
      fill.style.opacity = "1";
      return;
    }

    const totalLength = line.getTotalLength();
    // Set up the dash for the draw effect
    line.style.strokeDasharray = `${totalLength}`;
    line.style.strokeDashoffset = `${totalLength}`;
    // Hide gradient fill initially
    fill.style.opacity = "0";

    // Animate the line drawing
    gsap.to(line, {
      strokeDashoffset: 0,
      duration: 1,
      ease: "power2.out",
      onComplete: () => {
        // Fade in gradient fill after line finishes drawing
        gsap.to(fill, {
          opacity: 1,
          duration: 0.5,
          ease: "power2.out",
        });
      },
    });
  }, [points, prefersReduced]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || prices.length === 0) return;
    // Use SVG's own transform matrix for accurate screen→viewBox mapping
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const svgX = (e.clientX - ctm.e) / ctm.a;
    // Map to chart area (account for left padding)
    const chartRatio = (svgX - 55) / 545;
    const clamped = Math.min(Math.max(chartRatio, 0), 1);
    const idx = Math.min(Math.max(Math.round(clamped * (prices.length - 1)), 0), prices.length - 1);
    setHoverState({ idx, mouseX: Math.min(Math.max(svgX, 55), 600) });
  }, [prices.length]);

  // Must call all hooks before any early return
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

  const yTicks = useMemo(() => {
    if (maxP === minP && maxP === 0) return [];
    const count = 4;
    const range = maxP - minP || 0.001;
    const ticks: { val: number; y: number }[] = [];
    for (let i = 0; i <= count; i++) {
      const val = minP + (range * i) / count;
      const y = 10 + (1 - i / count) * 120;
      ticks.push({ val, y });
    }
    return ticks;
  }, [minP, maxP]);

  const hoverInfo = useMemo(() => {
    if (hoverState === null || prices.length === 0) return null;
    const { idx, mouseX } = hoverState;
    const p = prices[idx];
    const val = p.price_e6 / 1e6;
    const range = (maxP - minP) || 0.001;
    const tRange = (maxT - minT) || 1;
    const dataX = 55 + ((p.timestamp - minT) / tRange) * 545;
    const y = 10 + (1 - (val - minP) / range) * 120;
    return { mouseX, dataX, y, price: val, time: new Date(p.timestamp * 1000) };
  }, [hoverState, prices, minP, maxP, minT, maxT]);

  // Show current price even with just 1 data point
  const currentPrice = config
    ? Number(config.authorityPriceE6 ?? config.lastEffectivePriceE6 ?? 0) / 1e6
    : 0;

  if (prices.length < 2) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center">
        {currentPrice > 0 ? (
          <>
            <div className="text-2xl font-bold text-white">${currentPrice < 0.01 ? currentPrice.toFixed(6) : currentPrice.toFixed(2)}</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">Price chart building... (updates with each trade)</div>
          </>
        ) : (
          <>
            <div className="text-sm text-[var(--text-muted)]">No price data yet</div>
            <div className="mt-1 text-xs text-[var(--text-muted)]">Prices will appear after the first trade on this market.</div>
          </>
        )}
      </div>
    );
  }

  const color = isUp ? "#14F195" : "#FF3B5C";
  const hoveredPrice = hoverState !== null ? prices[hoverState.idx].price_e6 / 1e6 : null;

  const fmtPrice = (p: number) => (p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2));

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-[var(--text-secondary)]">Price</span>
        <div className="flex gap-3">
          <span className="text-[var(--text-muted)]">
            24h High <span className="text-white">${fmtPrice(high)}</span>
          </span>
          <span className="text-[var(--text-muted)]">
            24h Low <span className="text-white">${fmtPrice(low)}</span>
          </span>
          <span style={{ color }}>
            ${fmtPrice(hoveredPrice ?? curPrice)}
          </span>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 600 160"
        className="w-full"
        style={{ height: 160 }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverState(null)}
      >
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Y-axis grid lines and labels */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={55}
              y1={tick.y}
              x2={600}
              y2={tick.y}
              stroke="rgba(153,69,255,0.12)"
              strokeDasharray="2,4"
            />
            <text
              x={50}
              y={tick.y + 3}
              textAnchor="end"
              fill="#7A7F96"
              fontSize="9"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              ${fmtPrice(tick.val)}
            </text>
          </g>
        ))}
        <polygon
          ref={polygonRef}
          points={`${points} 600,130 55,130`}
          fill="url(#chartGrad)"
          style={{ opacity: prefersReduced ? 1 : 0 }}
        />
        <polyline
          ref={polylineRef}
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2"
        />
        {/* Current price dot */}
        {prices.length > 0 && (() => {
          const lastPts = points.split(" ");
          const last = lastPts[lastPts.length - 1];
          const [cx, cy] = last.split(",");
          return (
            <circle
              cx={cx}
              cy={cy}
              r="3"
              fill={color}
              className="animate-[pulse-glow_2s_ease-in-out_infinite]"
            />
          );
        })()}
        {/* Hover crosshair */}
        {hoverInfo && (
          <g>
            {/* Vertical line — follows cursor */}
            <line
              x1={hoverInfo.mouseX}
              y1={10}
              x2={hoverInfo.mouseX}
              y2={130}
              stroke="#454B5F"
              strokeDasharray="3,3"
              strokeWidth="0.5"
            />
            {/* Horizontal line — snaps to data point */}
            <line
              x1={55}
              y1={hoverInfo.y}
              x2={600}
              y2={hoverInfo.y}
              stroke="#454B5F"
              strokeDasharray="3,3"
              strokeWidth="0.5"
            />
            {/* Dot on price line — snaps to data point */}
            <circle
              cx={hoverInfo.dataX}
              cy={hoverInfo.y}
              r="3.5"
              fill={color}
              stroke="#0A0A0F"
              strokeWidth="1.5"
            />
            {/* Y-axis price tag */}
            <rect
              x={0}
              y={hoverInfo.y - 7}
              width={52}
              height={14}
              rx={2}
              fill="#9945FF"
            />
            <text
              x={26}
              y={hoverInfo.y + 3}
              textAnchor="middle"
              fill="white"
              fontSize="9"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              ${fmtPrice(hoverInfo.price)}
            </text>
            {/* X-axis time tag — follows cursor */}
            <rect
              x={hoverInfo.mouseX - 28}
              y={132}
              width={56}
              height={14}
              rx={2}
              fill="#9945FF"
            />
            <text
              x={hoverInfo.mouseX}
              y={142}
              textAnchor="middle"
              fill="white"
              fontSize="9"
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {hoverInfo.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </text>
          </g>
        )}
      </svg>
      <div className="relative mt-1 flex justify-between text-[10px] text-[var(--text-muted)]" style={{ paddingLeft: "9.17%" }}>
        {timeLabels.map((tl, i) => (
          <span key={i}>{tl.label}</span>
        ))}
      </div>
    </div>
  );
};
