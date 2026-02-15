"use client";

import { FC, useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useLivePrice } from "@/hooks/useLivePrice";

type ChartType = "line" | "candle";
type Timeframe = "1h" | "4h" | "1d" | "7d" | "30d";

interface PricePoint {
  timestamp: number;
  price: number;
}

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const CANDLE_INTERVAL_MS = 5 * 60 * 1000; // 5-minute candles

function aggregateCandles(prices: PricePoint[], intervalMs: number): CandleData[] {
  if (prices.length === 0) return [];
  
  const candles: CandleData[] = [];
  let currentCandle: CandleData | null = null;
  
  prices.forEach((point) => {
    const candleStart = Math.floor(point.timestamp / intervalMs) * intervalMs;
    
    if (!currentCandle || currentCandle.timestamp !== candleStart) {
      if (currentCandle) candles.push(currentCandle);
      currentCandle = {
        timestamp: candleStart,
        open: point.price,
        high: point.price,
        low: point.price,
        close: point.price,
        volume: 0,
      };
    } else {
      currentCandle.high = Math.max(currentCandle.high, point.price);
      currentCandle.low = Math.min(currentCandle.low, point.price);
      currentCandle.close = point.price;
    }
  });
  
  if (currentCandle) candles.push(currentCandle);
  return candles;
}

const W = 800;
const H = 400;
const CHART_H = 300;
const VOLUME_H = 60;
const PAD = { top: 20, bottom: 40, left: 60, right: 20 };

export const TradingChart: FC<{ slabAddress: string; simulation?: boolean }> = ({ slabAddress, simulation }) => {
  const { config } = useSlabState();
  const { priceUsd } = useLivePrice({ simulation });
  const [chartType, setChartType] = useState<ChartType>("line");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [prices, setPrices] = useState<PricePoint[]>([]);
  const [hoveredCandle, setHoveredCandle] = useState<CandleData | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Fetch price history (skip in simulation — live prices build up from WebSocket)
  useEffect(() => {
    if (simulation) return;
    fetch(`/api/markets/${slabAddress}/prices`)
      .then((r) => r.json())
      .then((d) => {
        const apiPrices = (d.prices ?? []).map((p: { price_e6: string; timestamp: number }) => ({
          timestamp: p.timestamp,
          price: parseInt(p.price_e6) / 1e6,
        }));
        setPrices(apiPrices);
      })
      .catch(() => {});
  }, [slabAddress, simulation]);

  // Add live price updates
  useEffect(() => {
    if (!config || !priceUsd) return;
    const now = Date.now();
    setPrices((prev) => {
      const last = prev[prev.length - 1];
      if (last && now - last.timestamp < 5000) return prev;
      return [...prev, { timestamp: now, price: priceUsd }].slice(-1000);
    });
  }, [config, priceUsd]);

  // Filter by timeframe
  const filteredPrices = useMemo(() => {
    const cutoff = Date.now() - TIMEFRAME_MS[timeframe];
    return prices.filter((p) => p.timestamp >= cutoff);
  }, [prices, timeframe]);

  // Generate candles or use line data
  const { candles, lineData } = useMemo(() => {
    if (chartType === "candle") {
      return { candles: aggregateCandles(filteredPrices, CANDLE_INTERVAL_MS), lineData: [] };
    }
    return { candles: [], lineData: filteredPrices };
  }, [filteredPrices, chartType]);

  // Calculate chart bounds
  const { minPrice, maxPrice, minTime, maxTime, priceRange } = useMemo(() => {
    const data = chartType === "candle" ? candles : lineData;
    if (data.length === 0) {
      return { minPrice: 0, maxPrice: 0, minTime: 0, maxTime: 0, priceRange: 0 };
    }

    let min = Infinity;
    let max = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;

    data.forEach((d) => {
      if ("high" in d && "low" in d) {
        min = Math.min(min, d.low);
        max = Math.max(max, d.high);
      } else if ("price" in d) {
        min = Math.min(min, d.price);
        max = Math.max(max, d.price);
      }
      tMin = Math.min(tMin, d.timestamp);
      tMax = Math.max(tMax, d.timestamp);
    });

    // Add padding if price is stable
    const rawRange = max - min;
    const avg = (min + max) / 2;
    if (rawRange < avg * 0.001 || rawRange === 0) {
      const padding = avg * 0.01;
      min = avg - padding;
      max = avg + padding;
    }

    return {
      minPrice: min,
      maxPrice: max,
      minTime: tMin,
      maxTime: tMax,
      priceRange: max - min,
    };
  }, [candles, lineData, chartType]);

  const CHART_W = W - PAD.left - PAD.right;

  // Render line chart
  const linePath = useMemo(() => {
    if (chartType !== "line" || lineData.length === 0) return "";
    
    const timeRange = maxTime - minTime || 1;
    const safePriceRange = priceRange || 1;
    const points = lineData.map((p) => {
      const x = PAD.left + ((p.timestamp - minTime) / timeRange) * CHART_W;
      const y = PAD.top + ((maxPrice - p.price) / safePriceRange) * CHART_H;
      return `${x},${y}`;
    });
    
    return points.join(" ");
  }, [lineData, minTime, maxTime, minPrice, maxPrice, priceRange, CHART_W, chartType]);

  // Y-axis labels
  const yLabels = useMemo(() => {
    const labels: { y: number; value: number }[] = [];
    const count = 5;
    for (let i = 0; i <= count; i++) {
      const price = maxPrice - (priceRange * i) / count;
      const y = PAD.top + (i / count) * CHART_H;
      labels.push({ y, value: price });
    }
    return labels;
  }, [minPrice, maxPrice, priceRange]);

  // X-axis labels
  const xLabels = useMemo(() => {
    const labels: { x: number; time: string }[] = [];
    const count = 6;
    const timeRange = maxTime - minTime || 1;
    for (let i = 0; i <= count; i++) {
      const t = minTime + (timeRange * i) / count;
      const date = new Date(t);
      const x = PAD.left + (i / count) * CHART_W;
      const format =
        timeframe === "1h" || timeframe === "4h"
          ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : date.toLocaleDateString([], { month: "short", day: "numeric" });
      labels.push({ x, time: format });
    }
    return labels;
  }, [minTime, maxTime, timeframe, CHART_W]);

  const currentPrice = filteredPrices[filteredPrices.length - 1]?.price ?? priceUsd ?? 0;
  const firstPrice = filteredPrices[0]?.price ?? currentPrice;
  const priceChange = currentPrice - firstPrice;
  const priceChangePercent = firstPrice > 0 ? (priceChange / firstPrice) * 100 : 0;
  const isUp = priceChange >= 0;

  if (filteredPrices.length === 0) {
    return (
      <div className="flex h-[400px] items-center justify-center rounded-none border border-[var(--border)] bg-[var(--bg)]">
        <div className="text-center">
          <div className="text-sm text-[var(--text-secondary)]">No price data yet</div>
          <div className="mt-1 text-xs text-[var(--text-dim)]">Prices will appear after trades</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-[var(--border)] bg-[var(--bg)] p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-2xl font-bold" style={{ fontFamily: "var(--font-mono)", color: isUp ? "var(--long)" : "var(--short)" }}>
            ${currentPrice.toFixed(currentPrice < 1 ? 4 : 2)}
          </div>
          <div className="text-xs" style={{ color: isUp ? "var(--long)" : "var(--short)" }}>
            {isUp ? "+" : ""}{priceChange.toFixed(4)} ({isUp ? "+" : ""}{priceChangePercent.toFixed(2)}%)
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Chart type */}
          <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
            <button
              onClick={() => setChartType("line")}
              className={`rounded-none px-2 py-1 text-xs transition-colors ${
                chartType === "line"
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
              }`}
            >
              Line
            </button>
            <button
              onClick={() => setChartType("candle")}
              className={`rounded-none px-2 py-1 text-xs transition-colors ${
                chartType === "candle"
                  ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                  : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
              }`}
            >
              Candle
            </button>
          </div>

          {/* Timeframe */}
          <div className="flex gap-1 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
            {(["1h", "4h", "1d", "7d", "30d"] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`rounded-none px-2 py-1 text-xs transition-colors ${
                  timeframe === tf
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart */}
      <svg ref={svgRef} width={W} height={H} className="w-full" style={{ maxWidth: "100%" }}>
        <defs>
          <linearGradient id="lineGradient" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={isUp ? "var(--long)" : "var(--short)"} stopOpacity="0.3" />
            <stop offset="100%" stopColor={isUp ? "var(--long)" : "var(--short)"} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {yLabels.map((label, i) => (
          <line
            key={`grid-y-${i}`}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={label.y}
            y2={label.y}
            stroke="var(--border)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.3"
          />
        ))}

        {/* Y-axis labels */}
        {yLabels.map((label, i) => (
          <text
            key={`label-y-${i}`}
            x={PAD.left - 10}
            y={label.y + 4}
            textAnchor="end"
            fontSize="10"
            fill="var(--text-dim)"
            fontFamily="var(--font-mono)"
          >
            ${label.value.toFixed(label.value < 1 ? 4 : 2)}
          </text>
        ))}

        {/* X-axis labels */}
        {xLabels.map((label, i) => (
          <text
            key={`label-x-${i}`}
            x={label.x}
            y={PAD.top + CHART_H + 20}
            textAnchor="middle"
            fontSize="10"
            fill="var(--text-dim)"
          >
            {label.time}
          </text>
        ))}

        {/* Line chart */}
        {chartType === "line" && linePath && (
          <>
            <polygon
              points={`${linePath} ${W - PAD.right},${PAD.top + CHART_H} ${PAD.left},${PAD.top + CHART_H}`}
              fill="url(#lineGradient)"
            />
            <polyline
              points={linePath}
              fill="none"
              stroke={isUp ? "var(--long)" : "var(--short)"}
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </>
        )}

        {/* Candlestick chart */}
        {chartType === "candle" &&
          candles.map((candle, i) => {
            const timeRange = maxTime - minTime || 1;
            const x = PAD.left + ((candle.timestamp - minTime) / timeRange) * CHART_W;
            const safePriceRange = priceRange || 1;
            const yOpen = PAD.top + ((maxPrice - candle.open) / safePriceRange) * CHART_H;
            const yClose = PAD.top + ((maxPrice - candle.close) / safePriceRange) * CHART_H;
            const yHigh = PAD.top + ((maxPrice - candle.high) / safePriceRange) * CHART_H;
            const yLow = PAD.top + ((maxPrice - candle.low) / safePriceRange) * CHART_H;
            const candleW = Math.max(2, CHART_W / candles.length - 2);
            const isGreen = candle.close >= candle.open;
            const color = isGreen ? "var(--long)" : "var(--short)";

            return (
              <g key={i}>
                {/* Wick */}
                <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth="1" />
                {/* Body */}
                <rect
                  x={x - candleW / 2}
                  y={Math.min(yOpen, yClose)}
                  width={candleW}
                  height={Math.max(1, Math.abs(yClose - yOpen))}
                  fill={color}
                  opacity="0.9"
                />
              </g>
            );
          })}
      </svg>
    </div>
  );
};
