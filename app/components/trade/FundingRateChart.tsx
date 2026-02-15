"use client";

import { FC, useState, useEffect, useMemo } from "react";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

interface FundingHistoryPoint {
  slot: number;
  rateBpsPerSlot: number;
  timestamp: number;
  hourlyRatePercent: number;
}

// Generate mock 24h data
function generateMockHistory(): FundingHistoryPoint[] {
  const now = Date.now();
  const points: FundingHistoryPoint[] = [];
  
  for (let i = 24; i >= 0; i--) {
    const timestamp = now - i * 60 * 60 * 1000; // Every hour
    const slot = 123456789 - i * 9000; // ~9000 slots per hour
    // Simulate oscillating funding rate
    const rateBpsPerSlot = Math.sin(i * 0.5) * 3 + Math.random() * 2 - 1;
    const hourlyRatePercent = (rateBpsPerSlot * 9000) / 100; // Convert to hourly %
    
    points.push({ slot, rateBpsPerSlot, timestamp, hourlyRatePercent });
  }
  
  return points;
}

const MOCK_HISTORY = generateMockHistory();

const W = 800;
const H = 300;
const PAD = { top: 20, bottom: 40, left: 60, right: 20 };
const CHART_W = W - PAD.left - PAD.right;
const CHART_H = H - PAD.top - PAD.bottom;

export const FundingRateChart: FC<{ slabAddress: string; simulation?: boolean }> = ({ slabAddress, simulation }) => {
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const [history, setHistory] = useState<FundingHistoryPoint[]>(mockMode ? MOCK_HISTORY : []);
  const [loading, setLoading] = useState(!mockMode && !simulation);
  const [hoveredPoint, setHoveredPoint] = useState<FundingHistoryPoint | null>(null);
  const [mouseX, setMouseX] = useState(0);

  useEffect(() => {
    if (mockMode || simulation) return;

    const fetchHistory = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/funding/${slabAddress}/history`);
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        setHistory(data.history ?? []);
      } catch {
        // Fallback to mock
        setHistory(MOCK_HISTORY);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [slabAddress, mockMode, simulation]);

  const { minRate, maxRate, rateRange, minTime, maxTime, timeRange } = useMemo(() => {
    if (history.length === 0) {
      return { minRate: 0, maxRate: 0, rateRange: 0, minTime: 0, maxTime: 0, timeRange: 0 };
    }

    let min = Infinity;
    let max = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;

    history.forEach((p) => {
      min = Math.min(min, p.hourlyRatePercent);
      max = Math.max(max, p.hourlyRatePercent);
      tMin = Math.min(tMin, p.timestamp);
      tMax = Math.max(tMax, p.timestamp);
    });

    // Ensure zero is visible
    min = Math.min(min, 0);
    max = Math.max(max, 0);

    // Add padding (guard against zero range)
    const range = max - min;
    if (range === 0) {
      const fallback = Math.abs(max) * 0.1 || 0.01;
      min -= fallback;
      max += fallback;
    } else {
      const padding = range * 0.1;
      min -= padding;
      max += padding;
    }

    return {
      minRate: min,
      maxRate: max,
      rateRange: max - min,
      minTime: tMin,
      maxTime: tMax,
      timeRange: tMax - tMin || 1,
    };
  }, [history]);

  // Calculate zero line Y position
  const zeroY = rateRange > 0 ? PAD.top + ((maxRate - 0) / rateRange) * CHART_H : PAD.top + CHART_H / 2;

  // Generate line path
  const linePath = useMemo(() => {
    if (history.length === 0) return "";
    return history
      .map((p) => {
        const x = PAD.left + ((p.timestamp - minTime) / timeRange) * CHART_W;
        const y = PAD.top + ((maxRate - p.hourlyRatePercent) / rateRange) * CHART_H;
        return `${x},${y}`;
      })
      .join(" ");
  }, [history, minTime, maxTime, minRate, maxRate, rateRange, timeRange]);

  // Generate positive/negative area paths
  const { positivePath, negativePath } = useMemo(() => {
    if (history.length === 0) return { positivePath: "", negativePath: "" };

    const positive: string[] = [];
    const negative: string[] = [];

    history.forEach((p, i) => {
      const x = PAD.left + ((p.timestamp - minTime) / timeRange) * CHART_W;
      const y = PAD.top + ((maxRate - p.hourlyRatePercent) / rateRange) * CHART_H;

      if (p.hourlyRatePercent >= 0) {
        if (positive.length === 0 && i > 0) {
          // Add interpolated zero crossing
          const prevX = PAD.left + ((history[i - 1].timestamp - minTime) / timeRange) * CHART_W;
          positive.push(`${prevX},${zeroY}`);
        }
        positive.push(`${x},${y}`);
      } else {
        if (negative.length === 0 && i > 0) {
          const prevX = PAD.left + ((history[i - 1].timestamp - minTime) / timeRange) * CHART_W;
          negative.push(`${prevX},${zeroY}`);
        }
        negative.push(`${x},${y}`);
      }

      // Close segments at zero crossings
      if (i < history.length - 1) {
        const next = history[i + 1];
        if ((p.hourlyRatePercent >= 0) !== (next.hourlyRatePercent >= 0)) {
          const nextX = PAD.left + ((next.timestamp - minTime) / timeRange) * CHART_W;
          if (p.hourlyRatePercent >= 0) {
            positive.push(`${nextX},${zeroY}`);
          } else {
            negative.push(`${nextX},${zeroY}`);
          }
        }
      }
    });

    // Close polygons
    const posPath = positive.length > 0
      ? `${positive.join(" ")} ${positive[positive.length - 1].split(",")[0]},${zeroY} ${positive[0].split(",")[0]},${zeroY}`
      : "";
    const negPath = negative.length > 0
      ? `${negative.join(" ")} ${negative[negative.length - 1].split(",")[0]},${zeroY} ${negative[0].split(",")[0]},${zeroY}`
      : "";

    return { positivePath: posPath, negativePath: negPath };
  }, [history, minTime, maxTime, minRate, maxRate, rateRange, timeRange, zeroY]);

  // Y-axis labels
  const yLabels = useMemo(() => {
    const labels: { y: number; value: number }[] = [];
    const count = 5;
    for (let i = 0; i <= count; i++) {
      const rate = maxRate - (rateRange * i) / count;
      const y = PAD.top + (i / count) * CHART_H;
      labels.push({ y, value: rate });
    }
    return labels;
  }, [minRate, maxRate, rateRange]);

  // X-axis labels
  const xLabels = useMemo(() => {
    const labels: { x: number; time: string }[] = [];
    const count = 6;
    for (let i = 0; i <= count; i++) {
      const t = minTime + (timeRange * i) / count;
      const date = new Date(t);
      const x = PAD.left + (i / count) * CHART_W;
      const format = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      labels.push({ x, time: format });
    }
    return labels;
  }, [minTime, maxTime, timeRange]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setMouseX(x);

    // Find nearest point
    const chartX = x - PAD.left;
    const timestamp = minTime + (chartX / CHART_W) * timeRange;
    
    let nearest: FundingHistoryPoint | null = null;
    let minDist = Infinity;
    
    history.forEach((p) => {
      const dist = Math.abs(p.timestamp - timestamp);
      if (dist < minDist) {
        minDist = dist;
        nearest = p;
      }
    });
    
    setHoveredPoint(nearest);
  };

  const handleMouseLeave = () => {
    setHoveredPoint(null);
  };

  if (loading) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
        <div className="h-8 w-8 animate-spin border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
        <div className="text-center">
          <div className="text-sm text-[var(--text-secondary)]">No funding history yet</div>
          <div className="mt-1 text-xs text-[var(--text-dim)]">Data will appear after cranks</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Funding Rate (24h)
        </h3>
        {hoveredPoint && (
          <div className="text-right">
            <div className={`text-sm font-bold ${hoveredPoint.hourlyRatePercent >= 0 ? "text-[var(--short)]" : "text-[var(--long)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
              {hoveredPoint.hourlyRatePercent >= 0 ? "+" : ""}
              {hoveredPoint.hourlyRatePercent.toFixed(4)}%/h
            </div>
            <div className="text-[10px] text-[var(--text-dim)]">
              {new Date(hoveredPoint.timestamp).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <svg width={W} height={H} className="w-full" style={{ maxWidth: "100%" }} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
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

        {/* Zero line */}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={zeroY}
          y2={zeroY}
          stroke="var(--text-dim)"
          strokeWidth="2"
          strokeDasharray="6 3"
          opacity="0.5"
        />

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
            {label.value >= 0 ? "+" : ""}
            {label.value.toFixed(3)}%
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

        {/* Positive area (red - longs pay) */}
        {positivePath && (
          <polygon points={positivePath} fill="var(--short)" opacity="0.15" />
        )}

        {/* Negative area (green - shorts pay) */}
        {negativePath && (
          <polygon points={negativePath} fill="var(--long)" opacity="0.15" />
        )}

        {/* Line */}
        <polyline
          points={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Hover indicator */}
        {hoveredPoint && (
          <line
            x1={mouseX}
            x2={mouseX}
            y1={PAD.top}
            y2={PAD.top + CHART_H}
            stroke="var(--accent)"
            strokeWidth="1"
            strokeDasharray="4 4"
            opacity="0.5"
          />
        )}
      </svg>
    </div>
  );
};
