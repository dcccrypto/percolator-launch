"use client";

/**
 * Minimal dependency-free SVG line chart for the growth dashboard: a few time series on a shared
 * x axis, one y axis, direct end labels and a text summary for screen readers. Colours come from the
 * app's CSS variables so it follows the theme.
 */
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** (unix ms, value) pairs; null values break the line. */
  points: ReadonlyArray<readonly [number, number | null]>;
  dashed?: boolean;
}

interface Props {
  title: string;
  series: ReadonlyArray<ChartSeries>;
  /** Value formatter for the y axis and the end labels. */
  format: (v: number) => string;
  /** Force the y range to start at zero (default true). */
  zeroBased?: boolean;
  height?: number;
}

const W = 640;
const PAD = { l: 48, r: 12, t: 10, b: 22 };

export function chartDomain(series: ReadonlyArray<ChartSeries>, zeroBased: boolean): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of series) {
    for (const [t, v] of s.points) {
      if (v === null || !Number.isFinite(v)) continue;
      x0 = Math.min(x0, t);
      x1 = Math.max(x1, t);
      y0 = Math.min(y0, v);
      y1 = Math.max(y1, v);
    }
  }
  if (!Number.isFinite(x0)) return null;
  if (zeroBased) y0 = Math.min(0, y0);
  if (y1 === y0) y1 = y0 + 1;
  if (x1 === x0) x1 = x0 + 1;
  return { x0, x1, y0, y1 };
}

export function linePath(pts: ReadonlyArray<readonly [number, number | null]>, sx: (t: number) => number, sy: (v: number) => number): string {
  let d = "";
  let pen = false;
  for (const [t, v] of pts) {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function CapacityChart({ title, series, format, zeroBased = true, height = 170 }: Props) {
  const dom = chartDomain(series, zeroBased);
  return (
    <figure className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-4" data-testid="capacity-chart">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
        <span className="font-medium text-[var(--text)]">{title}</span>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 normal-case tracking-normal">
            <svg width="14" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="14" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "3 2" : undefined} />
            </svg>
            {s.label}
          </span>
        ))}
      </figcaption>
      {dom === null ? (
        <p className="py-8 text-center text-sm text-[var(--text-muted)]">No snapshots in this window yet.</p>
      ) : (
        <ChartBody dom={dom} series={series} format={format} height={height} title={title} />
      )}
    </figure>
  );
}

function ChartBody({ dom, series, format, height, title }: { dom: NonNullable<ReturnType<typeof chartDomain>>; series: ReadonlyArray<ChartSeries>; format: (v: number) => string; height: number; title: string }) {
  const sx = (t: number) => PAD.l + ((t - dom.x0) / (dom.x1 - dom.x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number) => height - PAD.b - ((v - dom.y0) / (dom.y1 - dom.y0)) * (height - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map((f) => dom.y0 + f * (dom.y1 - dom.y0));
  const summary = series
    .map((s) => {
      const last = [...s.points].reverse().find(([, v]) => v !== null && Number.isFinite(v));
      return last && last[1] !== null ? `${s.label} ${format(last[1])}` : `${s.label} no data`;
    })
    .join(", ");
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label={`${title}. Latest: ${summary}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="var(--border-subtle)" strokeWidth="1" />
          <text x={PAD.l - 6} y={sy(v) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">
            {format(v)}
          </text>
        </g>
      ))}
      <text x={PAD.l} y={height - 6} fontSize="10" fill="var(--text-muted)">
        {new Date(dom.x0).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </text>
      <text x={W - PAD.r} y={height - 6} textAnchor="end" fontSize="10" fill="var(--text-muted)">
        {new Date(dom.x1).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
      </text>
      {series.map((s) => (
        <path key={s.key} d={linePath(s.points, sx, sy)} fill="none" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}
