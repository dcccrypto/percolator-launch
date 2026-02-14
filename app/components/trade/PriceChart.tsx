"use client";

import { FC, useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { isMockSlab, getMockPriceHistory } from "@/lib/mock-trade-data";

interface PricePoint {
  price_e6: number;
  timestamp: number;
}

const DEFAULT_W = 600;
const H = 300;
const PAD = { top: 16, bottom: 20, left: 8, right: 8 };
const CHART_H = H - PAD.top - PAD.bottom;

function fmtPrice(p: number) {
  return p < 0.01 ? p.toFixed(6) : p < 1 ? p.toFixed(4) : p.toFixed(2);
}

export const PriceChart: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { config } = useSlabState();
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);
  const polylineRef = useRef<SVGPolylineElement>(null);
  const polygonRef = useRef<SVGPolygonElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  const [W, setW] = useState(DEFAULT_W);
  const CHART_W = W - PAD.left - PAD.right;
  const roRef = useRef<ResizeObserver | null>(null);
  const chartWrapCallback = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!node) return;
    const w = node.clientWidth;
    if (w > 0) setW(w);
    const ro = new ResizeObserver(entries => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setW(cw);
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);

  const crosshairRef = useRef<SVGGElement>(null);
  const crossVLineRef = useRef<SVGLineElement>(null);
  const crossHLineRef = useRef<SVGLineElement>(null);
  const crossOuterRef = useRef<SVGCircleElement>(null);
  const crossInnerRef = useRef<SVGCircleElement>(null);
  const crossTimeBgRef = useRef<SVGRectElement>(null);
  const crossTimeTextRef = useRef<SVGTextElement>(null);
  const hoverPriceRef = useRef<HTMLSpanElement>(null);
  const hoverDateRef = useRef<HTMLDivElement>(null);
  const svgRectRef = useRef<DOMRect | null>(null);

  const lastPriceRef = useRef<number>(0);
  useEffect(() => {
    if (!config) return;
    const priceE6 = Number(config.authorityPriceE6 ?? config.lastEffectivePriceE6 ?? 0);
    if (priceE6 === 0 || priceE6 === lastPriceRef.current) return;
    lastPriceRef.current = priceE6;
    // Use milliseconds to match backend format
    const now = Date.now();
    setPrices(prev => {
      const next = [...prev, { price_e6: priceE6, timestamp: now }];
      return next.slice(-500);
    });
  }, [config]);

  useEffect(() => {
    if (isMockSlab(slabAddress)) {
      const mockPrices = getMockPriceHistory(slabAddress);
      if (mockPrices.length > 0) setPrices(mockPrices);
      return;
    }

    fetch(`/api/markets/${slabAddress}/prices`)
      .then((r) => r.json())
      .then((d) => {
        const apiPrices = (d.prices ?? []).map((p: { price_e6: string; timestamp: number }) => ({
          price_e6: parseInt(p.price_e6),
          timestamp: p.timestamp,
        }));
        if (apiPrices.length > 0) {
          setPrices(prev => {
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

  const { points, minP, maxP, curPrice, high, low, isUp, minT, maxT, vals, times } = useMemo(() => {
    if (prices.length === 0)
      return { points: "", minP: 0, maxP: 0, curPrice: 0, high: 0, low: 0, isUp: true, minT: 0, maxT: 0, vals: [] as number[], times: [] as number[] };

    const v = prices.map((p) => p.price_e6 / 1e6);
    // Backend returns timestamps in milliseconds
    const t = prices.map((p) => p.timestamp);
    const mn = Math.min(...v);
    const mx = Math.max(...v);
    const tMin = Math.min(...t);
    const tMax = Math.max(...t);
    
    // If price is stable (< 0.1% movement), add padding for better visualization
    let actualMin = mn;
    let actualMax = mx;
    const rawRange = mx - mn;
    const avgPrice = (mn + mx) / 2;
    
    if (rawRange < avgPrice * 0.001 || rawRange === 0) {
      // Stable price - add ±0.5% padding
      const padding = avgPrice * 0.005;
      actualMin = avgPrice - padding;
      actualMax = avgPrice + padding;
    }
    
    const range = actualMax - actualMin;
    const tRange = tMax - tMin || 1;

    const pts = prices
      .map((p, i) => {
        const x = PAD.left + ((t[i] - tMin) / tRange) * CHART_W;
        const y = PAD.top + (1 - (v[i] - actualMin) / range) * CHART_H;
        return `${x},${y}`;
      })
      .join(" ");

    return {
      points: pts,
      minP: actualMin, maxP: actualMax,
      curPrice: v[v.length - 1],
      high: mx, low: mn,
      isUp: v[v.length - 1] >= v[0],
      minT: tMin, maxT: tMax,
      vals: v, times: t,
    };
  }, [prices, W]);

  const dataRef = useRef({ vals: [] as number[], times: [] as number[], minP: 0, maxP: 0, minT: 0, maxT: 0, curPrice: 0, isUp: true });
  useEffect(() => {
    dataRef.current = { vals, times, minP, maxP, minT, maxT, curPrice, isUp };
  }, [vals, times, minP, maxP, minT, maxT, curPrice, isUp]);

  useEffect(() => {
    const line = polylineRef.current;
    const fill = polygonRef.current;
    if (!line || !fill || !points) return;

    if (prefersReduced) {
      line.style.strokeDasharray = "none";
      line.style.strokeDashoffset = "0";
      fill.style.opacity = "1";
      return;
    }

    const totalLength = line.getTotalLength();
    line.style.strokeDasharray = `${totalLength}`;
    line.style.strokeDashoffset = `${totalLength}`;
    fill.style.opacity = "0";

    gsap.to(line, {
      strokeDashoffset: 0,
      duration: 1,
      ease: "power2.out",
      onComplete: () => {
        gsap.to(fill, { opacity: 1, duration: 0.5, ease: "power2.out" });
      },
    });
  }, [points, prefersReduced]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const d = dataRef.current;
    if (d.vals.length === 0) return;

    if (!svgRectRef.current) svgRectRef.current = svg.getBoundingClientRect();
    const rect = svgRectRef.current;

    const svgX = (e.clientX - rect.left) / rect.width * W;
    const clampedX = Math.max(PAD.left, Math.min(W - PAD.right, svgX));
    const pct = (svgX - PAD.left) / CHART_W;
    const idx = Math.min(Math.max(Math.round(pct * (d.vals.length - 1)), 0), d.vals.length - 1);

    const tRange = d.maxT - d.minT || 1;
    const pRange = d.maxP - d.minP || 0.001;
    const hoverX = PAD.left + ((d.times[idx] - d.minT) / tRange) * CHART_W;
    const hoverY = PAD.top + (1 - (d.vals[idx] - d.minP) / pRange) * CHART_H;
    const clr = d.isUp ? "#14F195" : "#FF3B5C";

    crosshairRef.current?.setAttribute("display", "");

    const vLine = crossVLineRef.current;
    if (vLine) { vLine.setAttribute("x1", String(clampedX)); vLine.setAttribute("x2", String(clampedX)); }

    const hLine = crossHLineRef.current;
    if (hLine) { hLine.setAttribute("y1", String(hoverY)); hLine.setAttribute("y2", String(hoverY)); }

    const outer = crossOuterRef.current;
    if (outer) { outer.setAttribute("cx", String(hoverX)); outer.setAttribute("cy", String(hoverY)); outer.setAttribute("stroke", clr); }

    const inner = crossInnerRef.current;
    if (inner) { inner.setAttribute("cx", String(hoverX)); inner.setAttribute("cy", String(hoverY)); inner.setAttribute("fill", clr); }

    const timeBg = crossTimeBgRef.current;
    if (timeBg) timeBg.setAttribute("x", String(clampedX - 24));

    const timeText = crossTimeTextRef.current;
    if (timeText) {
      timeText.setAttribute("x", String(clampedX));
      // Timestamps are already in milliseconds
      const date = new Date(d.times[idx]);
      timeText.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    if (hoverPriceRef.current) {
      hoverPriceRef.current.textContent = `$${fmtPrice(d.vals[idx])}`;
      hoverPriceRef.current.style.color = clr;
    }
    if (hoverDateRef.current) {
      // Timestamps are already in milliseconds
      const date = new Date(d.times[idx]);
      hoverDateRef.current.textContent = date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    }
  }, [W, CHART_W]);

  const handleMouseLeave = useCallback(() => {
    crosshairRef.current?.setAttribute("display", "none");
    svgRectRef.current = null;
    const d = dataRef.current;
    const clr = d.isUp ? "#14F195" : "#FF3B5C";
    if (hoverPriceRef.current) {
      hoverPriceRef.current.textContent = `$${fmtPrice(d.curPrice)}`;
      hoverPriceRef.current.style.color = clr;
    }
    if (hoverDateRef.current) hoverDateRef.current.textContent = "\u00A0";
  }, []);

  useEffect(() => { svgRectRef.current = null; }, [W]);

  const yLabels = useMemo(() => {
    if (minP === maxP) return [];
    const labels: { y: number; label: string }[] = [];
    const count = 4;
    for (let i = 0; i <= count; i++) {
      const price = maxP - ((maxP - minP) * i) / count;
      const y = PAD.top + (i / count) * CHART_H;
      labels.push({ y, label: `$${fmtPrice(price)}` });
    }
    return labels;
  }, [minP, maxP]);

  const timeLabels = useMemo(() => {
    if (minT === maxT) return [];
    const labels: { x: number; label: string }[] = [];
    const count = 5;
    for (let i = 0; i <= count; i++) {
      const t = minT + ((maxT - minT) * i) / count;
      // Timestamps are already in milliseconds
      const d = new Date(t);
      labels.push({
        x: PAD.left + (i / count) * CHART_W,
        label: d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });
    }
    return labels;
  }, [minT, maxT, W]);

  const currentPrice = config
    ? Number(config.authorityPriceE6 ?? config.lastEffectivePriceE6 ?? 0) / 1e6
    : 0;

  if (prices.length < 2) {
    return (
      <div className="flex h-[200px] flex-col items-center justify-center rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 relative">
        {currentPrice > 0 ? (
          <>
            <div className="text-2xl font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>${currentPrice < 0.01 ? currentPrice.toFixed(6) : currentPrice.toFixed(2)}</div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Price chart building...</div>
          </>
        ) : (
          <>
            <div className="text-[11px] text-[var(--text-muted)]">No price data yet</div>
            <div className="mt-1 text-[10px] text-[var(--text-dim)]">Prices will appear after the first trade.</div>
          </>
        )}
      </div>
    );
  }

  const color = isUp ? "#14F195" : "#FF3B5C";

  const curPriceY = minP !== maxP
    ? PAD.top + (1 - (curPrice - minP) / (maxP - minP)) * CHART_H
    : null;

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px]">
        <span className="uppercase tracking-[0.15em] text-[var(--text-dim)]">Price</span>
        <div className="flex gap-3">
          <span className="text-[var(--text-dim)]">
            H <span className="font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>${fmtPrice(high)}</span>
          </span>
          <span className="text-[var(--text-dim)]">
            L <span className="font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>${fmtPrice(low)}</span>
          </span>
          <span ref={hoverPriceRef} className="font-bold" style={{ color, fontFamily: "var(--font-mono)" }}>
            ${fmtPrice(curPrice)}
          </span>
        </div>
      </div>
      <div ref={hoverDateRef} className="mb-0.5 h-3 text-right text-[9px] text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
        {"\u00A0"}
      </div>
      <div ref={chartWrapCallback}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          preserveAspectRatio="xMidYMid meet"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.15" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>

          {yLabels.map((yl, i) => (
            <line key={`grid-${i}`} x1={PAD.left} y1={yl.y} x2={W - PAD.right} y2={yl.y} style={{ stroke: "var(--border-subtle)" }} strokeWidth="1" />
          ))}

          {yLabels.map((yl, i) => (
            <text key={`ylabel-${i}`} x={PAD.left + 4} y={yl.y - 4} textAnchor="start" style={{ fill: "var(--text-dim)", fontFamily: "var(--font-mono)" }} fontSize="8">{yl.label}</text>
          ))}

          {curPriceY !== null && (
            <>
              <line x1={PAD.left} y1={curPriceY} x2={W - PAD.right} y2={curPriceY} stroke={color} strokeWidth="1" strokeDasharray="4 3" opacity="0.4" />
              <rect x={W - PAD.right - 52} y={curPriceY - 8} width={50} height={16} fill={color} opacity="0.15" />
              <text x={W - PAD.right - 4} y={curPriceY + 3} textAnchor="end" fill={color} fontSize="8" fontWeight="bold" style={{ fontFamily: "var(--font-mono)" }}>${fmtPrice(curPrice)}</text>
            </>
          )}

          <polygon
            ref={polygonRef}
            points={`${PAD.left},${PAD.top + CHART_H} ${points} ${W - PAD.right},${PAD.top + CHART_H}`}
            fill="url(#chartGrad)"
            style={{ opacity: prefersReduced ? 1 : 0 }}
          />

          <polyline
            ref={polylineRef}
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
          />

          {prices.length > 0 && (() => {
            const lastPts = points.split(" ");
            const last = lastPts[lastPts.length - 1];
            const [cx, cy] = last.split(",");
            return (
              <circle
                cx={cx}
                cy={cy}
                r="2.5"
                fill={color}
                className="animate-[pulse-glow_2s_ease-in-out_infinite]"
              />
            );
          })()}

          <g ref={crosshairRef} display="none">
            <line
              ref={crossVLineRef}
              x1="0" y1={PAD.top} x2="0" y2={PAD.top + CHART_H}
              style={{ stroke: "var(--accent)" }} strokeWidth="1" opacity="0.3"
            />
            <line
              ref={crossHLineRef}
              x1={PAD.left} y1="0" x2={W - PAD.right} y2="0"
              style={{ stroke: "var(--accent)" }} strokeWidth="1" strokeDasharray="3 3" opacity="0.3"
            />
            <circle ref={crossOuterRef} cx="0" cy="0" r="3.5" fill="none" strokeWidth="1.5" />
            <circle ref={crossInnerRef} cx="0" cy="0" r="1.5" />
            <rect
              ref={crossTimeBgRef}
              x="0" y={PAD.top + CHART_H + 2} width={48} height={14}
              style={{ fill: "var(--accent)" }} opacity="0.15"
            />
            <text
              ref={crossTimeTextRef}
              x="0" y={PAD.top + CHART_H + 12} textAnchor="middle"
              style={{ fill: "var(--accent)", fontFamily: "var(--font-mono)" }} fontSize="8"
            />
          </g>

          {timeLabels.map((tl, i) => (
            <text key={`time-${i}`} x={tl.x} y={H - 4} textAnchor="middle" style={{ fill: "var(--text-dim)", fontFamily: "var(--font-mono)" }} fontSize="8">{tl.label}</text>
          ))}
        </svg>
      </div>
    </div>
  );
};
