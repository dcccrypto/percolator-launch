"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";

/* ── Animated mini chart ─────────────────────────────────── */

// Generate a simple SVG polyline path from mock price data
function generateMockPath(
  seed: number,
  width: number,
  height: number,
  points = 40
): string {
  const prices: number[] = [];
  let price = 50;
  for (let i = 0; i < points; i++) {
    const rng = Math.sin(seed + i * 1.7) * 0.5 + Math.sin(seed + i * 0.3) * 0.3;
    price = Math.max(5, Math.min(95, price + rng * 8));
    prices.push(price);
  }
  return prices
    .map((p, i) => {
      const x = (i / (points - 1)) * width;
      const y = height - (p / 100) * height;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function MiniChart() {
  const [tick, setTick] = useState(0);
  const [chartColor, setChartColor] = useState("#22c55e"); // long = green

  useEffect(() => {
    const t = setInterval(() => {
      setTick((prev) => prev + 1);
      // Alternate between bull and bear to show both sides
      setChartColor((prev) => (prev === "#22c55e" ? "#ef4444" : "#22c55e"));
    }, 3000);
    return () => clearInterval(t);
  }, []);

  const w = 280;
  const h = 80;
  const path = generateMockPath(tick * 0.5, w, h);

  return (
    <div className="relative h-20 w-full overflow-hidden rounded-none border border-white/5 bg-white/[0.02]">
      {/* Gradient fill under line */}
      <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartColor} stopOpacity="0.2" />
            <stop offset="100%" stopColor={chartColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Area fill */}
        <path
          d={`${path} L ${w} ${h} L 0 ${h} Z`}
          fill="url(#chartFill)"
          className="transition-all duration-1000"
        />
        {/* Line */}
        <path
          d={path}
          fill="none"
          stroke={chartColor}
          strokeWidth="1.5"
          className="transition-all duration-1000"
          style={{
            filter: `drop-shadow(0 0 4px ${chartColor}66)`,
          }}
        />
      </svg>

      {/* Floating labels */}
      <div className="absolute left-2 top-1 flex items-center gap-1">
        <div
          className="h-1.5 w-1.5 animate-pulse rounded-full"
          style={{ backgroundColor: chartColor }}
        />
        <span className="text-[8px] font-bold uppercase tracking-[0.1em]" style={{ color: chartColor }}>
          {chartColor === "#22c55e" ? "LONG" : "SHORT"}
        </span>
      </div>
    </div>
  );
}

/* ── Animated stat ticker ────────────────────────────────── */
function AnimatedCount({
  target,
  prefix = "",
  suffix = "",
}: {
  target: number;
  prefix?: string;
  suffix?: string;
}) {
  const [val, setVal] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    const duration = 1200;
    const frame = () => {
      const elapsed = Date.now() - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setVal(Math.round(eased * target));
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, [target]);

  return (
    <span>
      {prefix}
      {val.toLocaleString()}
      {suffix}
    </span>
  );
}

/* ── Stats ───────────────────────────────────────────────── */
interface SimStats {
  traders: number;
  trades: number;
  volume: number;
}

function useSimStats(): SimStats {
  const [stats, setStats] = useState<SimStats>({ traders: 0, trades: 0, volume: 0 });

  useEffect(() => {
    // Fetch real leaderboard data to derive stats
    fetch("/api/simulate/leaderboard?period=alltime", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { entries?: { trade_count: number; total_deposited: number }[] }) => {
        const entries = data.entries ?? [];
        const traders = entries.length;
        const trades = entries.reduce((s, e) => s + (e.trade_count ?? 0), 0);
        const volume = entries.reduce((s, e) => s + Math.abs(e.total_deposited ?? 0), 0);
        setStats({ traders, trades, volume });
      })
      .catch(() => {
        // On error, show placeholder numbers
        setStats({ traders: 42, trades: 318, volume: 2_450_000 });
      });
  }, []);

  return stats;
}

/* ── Main component ─────────────────────────────────────── */

export function SimulatorHero() {
  const stats = useSimStats();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  return (
    <section className="relative overflow-hidden border-b border-white/5 bg-gradient-to-b from-[var(--accent)]/[0.03] to-transparent py-16 sm:py-24">
      {/* Background grid pattern */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(var(--text-dim) 1px, transparent 1px), linear-gradient(90deg, var(--text-dim) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      {/* Accent glow */}
      <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-96 -translate-x-1/2 rounded-full bg-[var(--accent)] opacity-[0.06] blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-5">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* ─ Left: text ─ */}
          <div className="text-center lg:text-left">
            {/* Badge */}
            <div className="mb-4 inline-flex items-center gap-2 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] px-3 py-1.5">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent)]" />
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--accent)]">
                Risk Engine Simulator
              </span>
            </div>

            {/* Headline */}
            <h2 className="mb-4 text-3xl font-bold leading-tight text-[var(--text)] sm:text-4xl lg:text-5xl">
              Trade with{" "}
              <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent)]/60 bg-clip-text text-transparent">
                zero risk.
              </span>
              <br />
              Learn everything.
            </h2>

            {/* Description */}
            <p className="mb-6 text-[13px] leading-relaxed text-[var(--text-secondary)] sm:text-[15px]">
              Experience Percolator&apos;s perpetuals risk engine firsthand —
              funding rates, liquidations, insurance fund, and more — using
              simulated funds on devnet.
            </p>

            {/* CTA */}
            <div className="flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link
                href="/simulate"
                className="inline-flex items-center gap-2 border border-[var(--accent)] bg-[var(--accent)]/10 px-6 py-3 text-[12px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] transition-all hover:bg-[var(--accent)]/20 hover:shadow-[0_0_20px_var(--accent)]/20"
              >
                Try the Risk Engine
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
              <a
                href="https://faucet.solana.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)] underline underline-offset-2"
              >
                Get devnet SOL first
              </a>
            </div>

            {/* Stats bar */}
            {mounted && (
              <div className="mt-8 flex flex-wrap items-center justify-center gap-6 lg:justify-start">
                <div className="text-center lg:text-left">
                  <div className="text-[11px] font-bold text-[var(--text)] font-mono">
                    {stats.traders > 0 ? (
                      <AnimatedCount target={stats.traders} />
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    Traders
                  </div>
                </div>
                <div className="h-8 w-px bg-white/10" />
                <div className="text-center lg:text-left">
                  <div className="text-[11px] font-bold text-[var(--text)] font-mono">
                    {stats.trades > 0 ? (
                      <AnimatedCount target={stats.trades} />
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    Trades
                  </div>
                </div>
                <div className="h-8 w-px bg-white/10" />
                <div className="text-center lg:text-left">
                  <div className="text-[11px] font-bold text-[var(--text)] font-mono">
                    {stats.volume > 0 ? (
                      <AnimatedCount
                        target={Math.round(stats.volume / 1000)}
                        prefix="$"
                        suffix="K"
                      />
                    ) : (
                      "—"
                    )}
                  </div>
                  <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    simUSDC Volume
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ─ Right: preview panel ─ */}
          <div className="relative">
            {/* Outer glow */}
            <div className="absolute inset-0 rounded-none bg-[var(--accent)]/5 blur-xl" />

            {/* Mock trading terminal */}
            <div className="relative border border-white/10 bg-[#0a0a0f] p-0 shadow-2xl">
              {/* Terminal header */}
              <div className="flex items-center justify-between border-b border-white/5 px-4 py-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-[#ff5f56]" />
                  <div className="h-2 w-2 rounded-full bg-[#ffbd2e]" />
                  <div className="h-2 w-2 rounded-full bg-[#27c93f]" />
                </div>
                <span className="text-[9px] font-mono text-[var(--text-dim)] uppercase tracking-[0.2em]">
                  SIM-SOL/USD · Devnet
                </span>
                <div className="flex items-center gap-1">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#27c93f]" />
                  <span className="text-[8px] text-[var(--text-dim)]">LIVE</span>
                </div>
              </div>

              {/* Chart */}
              <div className="p-3">
                <MiniChart />
              </div>

              {/* Mock positions */}
              <div className="border-t border-white/5 p-3">
                <div className="mb-2 text-[8px] font-semibold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Open Positions
                </div>
                <div className="space-y-1.5">
                  {[
                    { side: "LONG", size: "0.5 SOL", pnl: "+$124.50", positive: true },
                    { side: "SHORT", size: "0.2 BTC", pnl: "-$18.30", positive: false },
                  ].map((pos) => (
                    <div
                      key={pos.side + pos.size}
                      className="flex items-center justify-between border border-white/5 bg-white/[0.02] px-2 py-1.5"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={[
                            "rounded-none px-1 py-0.5 text-[8px] font-bold uppercase",
                            pos.positive
                              ? "bg-[var(--long)]/10 text-[var(--long)]"
                              : "bg-[var(--short)]/10 text-[var(--short)]",
                          ].join(" ")}
                        >
                          {pos.side}
                        </span>
                        <span className="text-[9px] font-mono text-[var(--text-secondary)]">
                          {pos.size}
                        </span>
                      </div>
                      <span
                        className={[
                          "text-[9px] font-bold font-mono",
                          pos.positive ? "text-[var(--long)]" : "text-[var(--short)]",
                        ].join(" ")}
                      >
                        {pos.pnl}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Risk metrics strip */}
              <div className="grid grid-cols-3 border-t border-white/5">
                {[
                  { label: "Liq. Price", val: "$142.30" },
                  { label: "Margin", val: "12.4%" },
                  { label: "Insurance", val: "$8,420" },
                ].map((m) => (
                  <div
                    key={m.label}
                    className="border-r border-white/5 px-3 py-2 last:border-r-0"
                  >
                    <div className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
                      {m.label}
                    </div>
                    <div className="text-[10px] font-bold font-mono text-[var(--text)]">
                      {m.val}
                    </div>
                  </div>
                ))}
              </div>

              {/* Watermark */}
              <div className="border-t border-white/5 px-4 py-2 text-center">
                <span className="text-[8px] uppercase tracking-[0.2em] text-[var(--text-dim)]">
                  Simulated · No real funds
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Feature bullets */}
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: "⚡",
              title: "Real Risk Engine",
              desc: "Same liquidation, funding & insurance mechanics as mainnet — just with sim funds.",
            },
            {
              icon: "🏆",
              title: "Weekly Leaderboard",
              desc: "Compete with other traders on PnL, ROI, and win rate. Resets every Monday.",
            },
            {
              icon: "📊",
              title: "Scenario Analysis",
              desc: "Stress-test your positions against historical market scenarios.",
            },
          ].map((f) => (
            <div key={f.title} className="border border-white/5 bg-white/[0.02] p-4">
              <div className="mb-2 text-2xl">{f.icon}</div>
              <h3 className="mb-1 text-[12px] font-semibold text-[var(--text)]">{f.title}</h3>
              <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
