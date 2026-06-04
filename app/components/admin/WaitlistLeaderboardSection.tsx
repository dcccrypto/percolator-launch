"use client";

import { useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useAdminFetch } from "@/hooks/useAdminFetch";

const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={labelStyle}>{children}</div>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

function IntegrityRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span
        className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold"
        style={{
          color: ok ? "var(--long)" : "var(--short)",
          background: ok ? "rgba(35,196,124,0.12)" : "rgba(238,80,80,0.12)",
          border: `1px solid ${ok ? "rgba(35,196,124,0.4)" : "rgba(238,80,80,0.4)"}`,
        }}
      >
        {ok ? "✓" : "!"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[var(--text)]">{label}</div>
        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 break-words">
          {detail}
        </div>
      </div>
    </div>
  );
}

interface AdminLeaderboardEntry {
  rank: number;
  referralCode: string;
  ownerPubkey: string | null;
  ownerEmail: string | null;
  twitterHandle: string | null;
  signupsReferred: number;
  joinedAt: string;
  tier: number;
}

interface WaitlistStats {
  totalSignups: number;
  byMethod: {
    walletOnly: number;
    emailOnly: number;
    walletAndEmail: number;
    withTwitter: number;
  };
  codeAssignment: {
    withCode: number;
    withoutCode: number;
    distinctCodes: number;
    duplicateCodes: { code: string; count: number }[];
    malformedCodes: string[];
  };
  attribution: {
    withReferrer: number;
    withoutReferrer: number;
    topReferrer: { code: string; count: number } | null;
    orphanedReferrers: string[];
  };
  emailNotification: {
    notifiedTotal: number;
    pendingEmailable: number;
    walletOnlyNoEmail: number;
  };
  recency: { last24h: number; last7d: number };
  growth?: { days: { date: string; count: number; cumulative: number }[] };
  spam?: {
    email: {
      disposableCount: number;
      disposableDomains: string[];
      topDomains: { domain: string; count: number }[];
      crossDomainLocalParts: { local: string; domains: number }[];
    };
    twitter: { botPatternCount: number; sample: string[] };
    velocity: {
      worstMinute: { at: string; count: number } | null;
      worst5Min: { startAt: string; count: number } | null;
      worstReferrerHour: { code: string; at: string; count: number } | null;
    };
    ip: {
      distinctIps: number;
      withoutIp: number;
      topIps: { ipHash: string; count: number }[];
      crossReferrerIps: { ipHash: string; referrers: number }[];
      worstIpHour: { ipHash: string; at: string; count: number } | null;
    };
  };
  tierBreakdown?: { tier: number; count: number; label: string }[];
  integrity: {
    selfReferrals: number;
    backfillComplete: boolean;
    codesUnique: boolean;
    allCodesValidShape: boolean;
    noOrphanedReferrers: boolean;
  };
}

function tierLabel(tier: number): string {
  return tier >= 0 && tier <= 25 ? String.fromCharCode(65 + tier) : `t${tier}`;
}

/**
 * Severity color for a quality-signal threshold.
 *  - level 0 = green / nominal
 *  - level 1 = amber / worth a glance
 *  - level 2 = red / probable inflation
 */
function severityColor(level: 0 | 1 | 2): string {
  return level === 0 ? "var(--long)" : level === 1 ? "#fbbf24" : "var(--short)";
}
function severityBg(level: 0 | 1 | 2): string {
  return level === 0
    ? "rgba(35,196,124,0.10)"
    : level === 1
      ? "rgba(251,191,36,0.10)"
      : "rgba(238,80,80,0.10)";
}

function SignalRow({
  level,
  label,
  value,
  detail,
}: {
  level: 0 | 1 | 2;
  label: string;
  value: string;
  detail: string;
}) {
  const color = severityColor(level);
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5"
      style={{
        background: severityBg(level),
        border: `1px solid ${color}40`,
      }}
    >
      <div
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold"
        style={{ color, background: `${color}22`, border: `1px solid ${color}66` }}
      >
        {level === 0 ? "✓" : level === 1 ? "~" : "!"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-[var(--text)]">{label}</div>
        <div className="text-[10.5px] text-[var(--text-muted)] mt-0.5 break-words">
          {detail}
        </div>
      </div>
      <div
        className="font-mono text-[14px] font-bold tabular-nums shrink-0"
        style={{ color }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Quality / spam-signals panel.
 *
 * Surfaces things you'd expect to look weird if a botnet inflated growth:
 * disposable-mail volume, twitter handles matching the "word + 6+ digit"
 * default-suggestion bot pattern, one-minute / five-minute signup spikes,
 * a single referrer hitting hundreds of invites in an hour, and the same
 * email local-part registered across many throwaway domains.
 *
 * Thresholds are conservative — these are heuristics, not proofs. Pair the
 * verdict here with the 30-day chart shape (smooth = organic, vertical
 * cliffs = bursty) before pulling rows.
 */
function SpamSignals({
  total,
  spam,
}: {
  total: number;
  spam: NonNullable<WaitlistStats["spam"]>;
}) {
  const disposablePct = total > 0 ? (spam.email.disposableCount / total) * 100 : 0;
  // Severity thresholds (tweak as the signal base evolves).
  const disposableLevel: 0 | 1 | 2 =
    disposablePct >= 5 ? 2 : disposablePct >= 1 ? 1 : 0;
  const botHandleLevel: 0 | 1 | 2 =
    spam.twitter.botPatternCount >= 50 ? 2 : spam.twitter.botPatternCount >= 15 ? 1 : 0;
  const minuteSpike = spam.velocity.worstMinute?.count ?? 0;
  const minuteLevel: 0 | 1 | 2 =
    minuteSpike >= 50 ? 2 : minuteSpike >= 20 ? 1 : 0;
  const fiveMinSpike = spam.velocity.worst5Min?.count ?? 0;
  const fiveMinLevel: 0 | 1 | 2 =
    fiveMinSpike >= 150 ? 2 : fiveMinSpike >= 60 ? 1 : 0;
  const refHourPeak = spam.velocity.worstReferrerHour?.count ?? 0;
  const refHourLevel: 0 | 1 | 2 =
    refHourPeak >= 100 ? 2 : refHourPeak >= 40 ? 1 : 0;
  const crossDomainCount = spam.email.crossDomainLocalParts.length;
  const crossDomainLevel: 0 | 1 | 2 =
    crossDomainCount >= 10 ? 2 : crossDomainCount >= 3 ? 1 : 0;
  // IP-based severities. ip is undefined on legacy /stats responses
  // (pre IP-capture deploy) — fall back to "no signal" so the panel
  // still renders cleanly during the rollout window.
  const ip = spam.ip;
  const topIpCount = ip?.topIps[0]?.count ?? 0;
  const topIpLevel: 0 | 1 | 2 =
    topIpCount >= 20 ? 2 : topIpCount >= 10 ? 1 : 0;
  const crossReferrerCount = ip?.crossReferrerIps.length ?? 0;
  const crossReferrerLevel: 0 | 1 | 2 =
    crossReferrerCount >= 10 ? 2 : crossReferrerCount >= 3 ? 1 : 0;
  const worstIpHourCount = ip?.worstIpHour?.count ?? 0;
  const worstIpHourLevel: 0 | 1 | 2 =
    worstIpHourCount >= 25 ? 2 : worstIpHourCount >= 10 ? 1 : 0;

  const levels = [
    disposableLevel,
    botHandleLevel,
    minuteLevel,
    fiveMinLevel,
    refHourLevel,
    crossDomainLevel,
    topIpLevel,
    crossReferrerLevel,
    worstIpHourLevel,
  ];
  const verdict = Math.max(...levels) as 0 | 1 | 2;
  const verdictLabel = verdict === 0 ? "Looks organic" : verdict === 1 ? "Watch closely" : "Signs of inflation";
  const verdictColor = severityColor(verdict);

  const formatTimeShort = (iso: string): string =>
    iso.replace("T", " ").replace("Z", "");

  return (
    <div className={`${card} p-4 mb-4`}>
      <div className="flex items-baseline justify-between mb-3">
        <div className={labelStyle}>Spam & Quality Signals</div>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: verdictColor }}
        >
          ● {verdictLabel}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
        <SignalRow
          level={disposableLevel}
          label="Disposable / throwaway email domains"
          value={`${spam.email.disposableCount} (${disposablePct.toFixed(2)}%)`}
          detail={
            spam.email.disposableCount === 0
              ? "no known throwaway-mail providers found"
              : `domains: ${spam.email.disposableDomains.slice(0, 5).join(", ")}${spam.email.disposableDomains.length > 5 ? "…" : ""}`
          }
        />
        <SignalRow
          level={botHandleLevel}
          label="Twitter handles matching bot pattern"
          value={spam.twitter.botPatternCount.toLocaleString()}
          detail={
            spam.twitter.botPatternCount === 0
              ? "no name+6digit handles found"
              : `e.g. @${spam.twitter.sample.slice(0, 3).join(", @")}`
          }
        />
        <SignalRow
          level={minuteLevel}
          label="Worst single-minute spike"
          value={`+${minuteSpike}`}
          detail={
            spam.velocity.worstMinute
              ? `at ${formatTimeShort(spam.velocity.worstMinute.at)} UTC`
              : "—"
          }
        />
        <SignalRow
          level={fiveMinLevel}
          label="Worst 5-minute spike"
          value={`+${fiveMinSpike}`}
          detail={
            spam.velocity.worst5Min
              ? `starting ${formatTimeShort(spam.velocity.worst5Min.startAt)} UTC`
              : "—"
          }
        />
        <SignalRow
          level={refHourLevel}
          label="Top referrer's busiest hour"
          value={`+${refHourPeak}`}
          detail={
            spam.velocity.worstReferrerHour
              ? `code ${spam.velocity.worstReferrerHour.code} · ${formatTimeShort(spam.velocity.worstReferrerHour.at)} UTC`
              : "—"
          }
        />
        <SignalRow
          level={crossDomainLevel}
          label="Same email handle across ≥3 domains"
          value={crossDomainCount.toLocaleString()}
          detail={
            crossDomainCount === 0
              ? "no cross-domain reuse"
              : spam.email.crossDomainLocalParts
                  .slice(0, 3)
                  .map((c) => `${c.local}@×${c.domains}`)
                  .join(" · ")
          }
        />
        {ip && (
          <>
            <SignalRow
              level={topIpLevel}
              label="Most-active IP (signups from one source)"
              value={`+${topIpCount}`}
              detail={
                ip.topIps.length === 0
                  ? `${ip.distinctIps.toLocaleString()} distinct IPs · ${ip.withoutIp.toLocaleString()} legacy NULL`
                  : `${ip.distinctIps.toLocaleString()} distinct · top ${ip.topIps
                      .slice(0, 3)
                      .map((x) => `${x.ipHash.slice(0, 8)}×${x.count}`)
                      .join(" · ")}`
              }
            />
            <SignalRow
              level={crossReferrerLevel}
              label="IPs spanning ≥3 referrer codes"
              value={crossReferrerCount.toLocaleString()}
              detail={
                crossReferrerCount === 0
                  ? "no cross-referrer IP clusters"
                  : ip.crossReferrerIps
                      .slice(0, 3)
                      .map((x) => `${x.ipHash.slice(0, 8)}×${x.referrers}`)
                      .join(" · ")
              }
            />
            <SignalRow
              level={worstIpHourLevel}
              label="Worst single-IP hour"
              value={`+${worstIpHourCount}`}
              detail={
                ip.worstIpHour
                  ? `${ip.worstIpHour.ipHash.slice(0, 8)} · at ${formatTimeShort(
                      ip.worstIpHour.at,
                    )} UTC`
                  : "—"
              }
            />
          </>
        )}
      </div>

      {/* Top email domains — eyeball check; healthy = gmail/outlook lead */}
      {spam.email.topDomains.length > 0 && (
        <div>
          <div className={`${labelStyle} mb-2`}>Top email domains</div>
          <div className="flex flex-wrap gap-1.5">
            {spam.email.topDomains.map(({ domain, count }) => {
              const isDisposable = spam.email.disposableDomains.includes(domain);
              return (
                <div
                  key={domain}
                  className="inline-flex items-center gap-1.5 rounded-none border px-2 py-1 font-mono text-[11px]"
                  style={{
                    color: isDisposable ? "var(--short)" : "var(--text)",
                    borderColor: isDisposable
                      ? "rgba(238,80,80,0.45)"
                      : "var(--border)",
                    background: isDisposable
                      ? "rgba(238,80,80,0.08)"
                      : "var(--bg)",
                  }}
                >
                  <span>{domain}</span>
                  <span className="text-[var(--text-muted)]">·</span>
                  <span className="tabular-nums">{count.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-[var(--text-muted)]">
        Heuristics, not proof — cross-check with the 30-day chart shape and the
        leaderboard's top referrer before pulling specific rows.
      </p>
    </div>
  );
}

/**
 * Signup growth chart — interactive, dual-axis, with a range selector.
 *
 * Visual goals:
 *   • KPI hero strip: big total, week-over-week growth chip, +today, +7d.
 *   • Smooth monotone cumulative curve (Catmull-Rom) over a richly
 *     gradient-filled area, with a soft glow underneath.
 *   • Daily bars sit subdued behind the line on a secondary right axis;
 *     the 7-day moving average rides on the same axis as a dashed line.
 *   • Pulsing dot on the latest day so "today" reads as live.
 *   • Crosshair + arrow-pointed tooltip on hover, refined typography.
 *   • Range selector pills (7D / 30D / 90D / All).
 */
type RangeKey = "7d" | "30d" | "90d" | "all";

// Catmull-Rom-to-Bezier smoothing. For monotonically non-decreasing series
// (a running cumulative is one) this gives a soft curve without overshoot.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]!.x},${pts[0]!.y}`;
  const out: string[] = [`M${pts[0]!.x.toFixed(2)},${pts[0]!.y.toFixed(2)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? pts[i + 1]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    out.push(
      `C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`,
    );
  }
  return out.join(" ");
}

function GrowthChart({
  days,
}: {
  days: { date: string; count: number; cumulative: number }[];
}) {
  const [range, setRange] = useState<RangeKey>("30d");
  const [hover, setHover] = useState<{ idx: number; px: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Precompute 7-day moving average over the FULL series so day 0 of the
  // visible window already has 6 days of prior context to average against.
  // Hooks run before any early-return so the call order stays stable across
  // renders even when the props briefly hand us an empty array.
  const ma7All = useMemo(() => {
    if (days.length === 0) return [] as number[];
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < days.length; i++) {
      sum += days[i]!.count;
      if (i >= 7) sum -= days[i - 7]!.count;
      out.push(sum / Math.min(7, i + 1));
    }
    return out;
  }, [days]);

  const sliceLen = useMemo(() => {
    if (days.length === 0) return 0;
    if (range === "7d") return Math.min(7, days.length);
    if (range === "30d") return Math.min(30, days.length);
    if (range === "90d") return Math.min(90, days.length);
    return days.length;
  }, [range, days.length]);

  if (days.length === 0) return null;
  const startIdx = days.length - sliceLen;
  const visible = days.slice(startIdx);
  const visibleMa = ma7All.slice(startIdx);

  // Y scales — cumulative left, daily right.
  const cumMin = visible[0]!.cumulative;
  const cumMax = visible[visible.length - 1]!.cumulative;
  const cumRange = Math.max(1, cumMax - cumMin);
  const maxDaily = Math.max(1, ...visible.map((d) => d.count));

  // SVG dimensions are logical; the container scales via viewBox/CSS.
  const W = 920;
  const H = 300;
  const padL = 56;
  const padR = 48;
  const padT = 18;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xAt = (i: number): number =>
    visible.length === 1
      ? padL + innerW / 2
      : padL + (i / (visible.length - 1)) * innerW;
  const yCum = (cum: number): number =>
    padT + innerH - ((cum - cumMin) / cumRange) * innerH;
  const yDaily = (count: number): number =>
    padT + innerH - (count / maxDaily) * innerH;

  // Y gridlines for the cumulative axis — pick 4 round increments.
  const niceStep = (raw: number): number => {
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const r = raw / mag;
    const n = r >= 5 ? 5 : r >= 2 ? 2 : 1;
    return n * mag;
  };
  const stepCum = niceStep(cumRange / 4) || 1;
  const firstGrid = Math.ceil(cumMin / stepCum) * stepCum;
  const gridValues: number[] = [];
  for (let v = firstGrid; v <= cumMax; v += stepCum) gridValues.push(v);

  // X-axis date ticks — show ~6 evenly-spaced ticks regardless of range.
  const tickCount = Math.min(6, visible.length);
  const tickIdxs: number[] = [];
  for (let k = 0; k < tickCount; k++) {
    tickIdxs.push(Math.round((k / Math.max(1, tickCount - 1)) * (visible.length - 1)));
  }
  const formatTick = (date: string): string => {
    const [, m, d] = date.split("-");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[Number(m) - 1]} ${Number(d)}`;
  };

  // Smooth Catmull-Rom curves. Bounded daily values (>=0) and a monotone
  // cumulative mean the spline rarely overshoots, so we don't bother with
  // the more expensive monotone-cubic variant.
  const cumPts = visible.map((d, i) => ({ x: xAt(i), y: yCum(d.cumulative) }));
  const cumPath = smoothPath(cumPts);
  const areaPath = `${cumPath} L${xAt(visible.length - 1).toFixed(2)},${(padT + innerH).toFixed(2)} L${xAt(0).toFixed(2)},${(padT + innerH).toFixed(2)} Z`;
  const ma7Pts = visibleMa.map((v, i) => ({ x: xAt(i), y: yDaily(v) }));
  const ma7Path = smoothPath(ma7Pts);

  // Header metrics — anchored to the FULL series (not the visible slice)
  // so WoW% stays comparable across range toggles.
  const total24h = days[days.length - 1]?.count ?? 0;
  const last7 = days.slice(-7).reduce((s, d) => s + d.count, 0);
  const prior7 = days.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  const wowPct = prior7 > 0 ? ((last7 - prior7) / prior7) * 100 : null;
  const totalRangeCount = visible.reduce((s, d) => s + d.count, 0);
  const grandTotal = cumMax;

  // Bar width — keep a small gap so bursts are still distinguishable
  // visually even at high density.
  const barW = visible.length > 0 ? Math.max(1, (innerW / visible.length) * 0.7) : 0;

  // Mouse → nearest day index.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pxToView = W / rect.width;
    const viewX = (e.clientX - rect.left) * pxToView;
    const t = (viewX - padL) / innerW;
    const clamped = Math.max(0, Math.min(1, t));
    const idx = Math.round(clamped * (visible.length - 1));
    setHover({ idx, px: e.clientX - rect.left });
  };
  const onLeave = () => setHover(null);

  const RANGES: { key: RangeKey; label: string }[] = [
    { key: "7d", label: "7D" },
    { key: "30d", label: "30D" },
    { key: "90d", label: "90D" },
    { key: "all", label: "All" },
  ];

  const hoverDay = hover ? visible[hover.idx] : null;
  const hoverMa = hover ? visibleMa[hover.idx] : null;

  const wowUp = (wowPct ?? 0) >= 0;
  const wowColor = wowPct === null ? "var(--text-muted)" : wowUp ? "var(--long)" : "var(--short)";
  const wowBg = wowPct === null
    ? "rgba(255,255,255,0.04)"
    : wowUp
      ? "rgba(35,196,124,0.12)"
      : "rgba(238,80,80,0.12)";

  return (
    <div className={`${card} p-5 mb-4`}>
      {/* Header row: label + range selector */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className={labelStyle}>Waitlist Growth</div>
        <div className="inline-flex rounded-none border border-[var(--border)] overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              disabled={r.key !== "all" && days.length <= ({ "7d": 7, "30d": 30, "90d": 90 }[r.key] ?? 0)}
              className={`relative font-mono text-[10px] uppercase tracking-[0.16em] px-3 py-1.5 border-l border-[var(--border)] first:border-l-0 transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                range === r.key
                  ? "bg-[var(--accent)]/14 text-[var(--text)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.06] hover:text-[var(--text)]"
              }`}
              style={
                range === r.key
                  ? { boxShadow: "inset 0 -2px 0 0 var(--accent)" }
                  : undefined
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI hero strip: huge total + WoW chip + secondary stats */}
      <div className="flex items-end justify-between mb-5 gap-6 flex-wrap">
        <div className="flex items-end gap-3">
          <div
            className="font-bold leading-none tabular-nums tracking-tight"
            style={{
              fontSize: 44,
              color: "var(--text)",
              fontFamily: "var(--font-display), var(--font-sans)",
              letterSpacing: "-0.025em",
            }}
          >
            {grandTotal.toLocaleString()}
          </div>
          <div className={`${labelStyle} mb-1`}>total</div>
          <div
            className="inline-flex items-center gap-1.5 px-2 py-1 mb-0.5 font-mono text-[11px] font-bold tabular-nums tracking-wide"
            style={{
              color: wowColor,
              background: wowBg,
              border: `1px solid ${wowColor}40`,
            }}
            title="Week-over-week: signups in the last 7 days vs the prior 7 days"
          >
            <span aria-hidden>
              {wowPct === null ? "•" : wowUp ? "▲" : "▼"}
            </span>
            <span>
              {wowPct === null
                ? "n/a"
                : `${wowUp ? "+" : ""}${wowPct.toFixed(1)}%`}
            </span>
            <span
              className="text-[10px] font-normal opacity-70 uppercase tracking-[0.14em]"
            >
              WoW
            </span>
          </div>
        </div>
        <div className="flex items-end gap-5 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
          <div className="flex flex-col items-end">
            <span className="text-[var(--text)] text-[16px] tabular-nums font-semibold">+{total24h}</span>
            <span className="mt-0.5">today</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[var(--text)] text-[16px] tabular-nums font-semibold">+{last7}</span>
            <span className="mt-0.5">7-day</span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[var(--text)] text-[16px] tabular-nums font-semibold">+{totalRangeCount}</span>
            <span className="mt-0.5">{range.toUpperCase()}</span>
          </div>
        </div>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height: H, display: "block" }}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          aria-label={`Waitlist signups · ${range} range · cumulative ${grandTotal.toLocaleString()}`}
        >
          <defs>
            <linearGradient id="growthArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
              <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="growthLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#B97AFF" />
              <stop offset="55%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="#14F195" />
            </linearGradient>
            {/* Soft glow under the cumulative line — gives it weight without
                being a hard outline. Wide blur, low alpha. */}
            <filter id="growthGlow" x="-10%" y="-50%" width="120%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComponentTransfer in="blur" result="blurAlpha">
                <feFuncA type="linear" slope="0.55" />
              </feComponentTransfer>
              <feMerge>
                <feMergeNode in="blurAlpha" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Y gridlines + left-axis cumulative labels */}
          {gridValues.map((v) => (
            <g key={`grid-${v}`}>
              <line
                x1={padL}
                x2={W - padR}
                y1={yCum(v)}
                y2={yCum(v)}
                stroke="var(--border)"
                strokeWidth={1}
                strokeDasharray="2 4"
                opacity={0.55}
              />
              <text
                x={padL - 8}
                y={yCum(v) + 3}
                textAnchor="end"
                fill="var(--text-muted)"
                fontSize={10}
                fontFamily="var(--font-mono), monospace"
              >
                {v.toLocaleString()}
              </text>
            </g>
          ))}
          {/* Right-axis daily label (max) */}
          <text
            x={W - padR + 8}
            y={yDaily(maxDaily) + 3}
            fill="var(--cyan)"
            fontSize={10}
            fontFamily="var(--font-mono), monospace"
          >
            +{maxDaily}
          </text>
          <text
            x={W - padR + 8}
            y={padT + innerH + 3}
            fill="var(--text-muted)"
            fontSize={10}
            fontFamily="var(--font-mono), monospace"
          >
            0
          </text>

          {/* Daily bars (right-axis scale) */}
          {visible.map((d, i) => {
            const x = xAt(i) - barW / 2;
            const y = yDaily(d.count);
            const h = padT + innerH - y;
            return (
              <rect
                key={d.date}
                x={x}
                y={y}
                width={barW}
                height={h}
                fill="var(--cyan)"
                opacity={0.22}
              />
            );
          })}

          {/* Cumulative area + line (left-axis scale) */}
          <path d={areaPath} fill="url(#growthArea)" />
          <path
            d={cumPath}
            fill="none"
            stroke="url(#growthLine)"
            strokeWidth={2.25}
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#growthGlow)"
          />

          {/* 7-day moving average — dashed cyan, daily-axis scale */}
          <path
            d={ma7Path}
            fill="none"
            stroke="var(--cyan)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.85}
          />

          {/* Pulsing dot on the latest cumulative point — reads as "live". */}
          {visible.length > 0 && (
            <g pointerEvents="none">
              <circle
                cx={xAt(visible.length - 1)}
                cy={yCum(visible[visible.length - 1]!.cumulative)}
                r={5}
                fill="var(--accent)"
                opacity={0.35}
              >
                <animate
                  attributeName="r"
                  values="5;14;5"
                  dur="2.2s"
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.45;0;0.45"
                  dur="2.2s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle
                cx={xAt(visible.length - 1)}
                cy={yCum(visible[visible.length - 1]!.cumulative)}
                r={4}
                fill="var(--accent)"
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
            </g>
          )}

          {/* X-axis ticks */}
          {tickIdxs.map((i) => (
            <g key={`xtick-${i}`}>
              <line
                x1={xAt(i)}
                x2={xAt(i)}
                y1={padT + innerH}
                y2={padT + innerH + 4}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={xAt(i)}
                y={H - 8}
                textAnchor="middle"
                fill="var(--text-muted)"
                fontSize={10}
                fontFamily="var(--font-mono), monospace"
              >
                {formatTick(visible[i]!.date)}
              </text>
            </g>
          ))}

          {/* Hover crosshair + dots */}
          {hover && hoverDay && (
            <g pointerEvents="none">
              <line
                x1={xAt(hover.idx)}
                x2={xAt(hover.idx)}
                y1={padT}
                y2={padT + innerH}
                stroke="var(--text-muted)"
                strokeWidth={1}
                opacity={0.6}
              />
              <circle
                cx={xAt(hover.idx)}
                cy={yCum(hoverDay.cumulative)}
                r={4}
                fill="var(--accent)"
                stroke="var(--bg)"
                strokeWidth={1.5}
              />
              {hoverMa !== null && (
                <circle
                  cx={xAt(hover.idx)}
                  cy={yDaily(hoverMa)}
                  r={3}
                  fill="var(--cyan)"
                  stroke="var(--bg)"
                  strokeWidth={1.5}
                />
              )}
            </g>
          )}
        </svg>

        {/* Hover tooltip — HTML overlay positioned in pixel space so it
            never gets stretched by the SVG's preserveAspectRatio="none". */}
        {hover && hoverDay && svgRef.current && (
          <div
            className="pointer-events-none absolute -translate-x-1/2"
            style={{
              left: Math.max(
                88,
                Math.min(
                  svgRef.current.getBoundingClientRect().width - 88,
                  hover.px,
                ),
              ),
              top: 12,
            }}
          >
            <div
              className="rounded-none border px-3 py-2 backdrop-blur-md"
              style={{
                borderColor: "var(--accent)",
                background:
                  "linear-gradient(180deg, rgba(15,16,24,0.96) 0%, rgba(10,10,15,0.92) 100%)",
                boxShadow:
                  "0 8px 24px -8px rgba(153,69,255,0.45), inset 0 0 0 1px rgba(153,69,255,0.18)",
                minWidth: 188,
              }}
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
                {formatTick(hoverDay.date)} · {hoverDay.date.slice(0, 4)}
              </div>
              <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
                <span className="text-[var(--text-muted)] uppercase tracking-[0.1em]">new</span>
                <span className="text-right text-[var(--text)] font-semibold">
                  +{hoverDay.count}
                </span>
                <span className="text-[var(--text-muted)] uppercase tracking-[0.1em]">7d avg</span>
                <span className="text-right text-[var(--cyan)]">
                  {hoverMa !== null ? hoverMa.toFixed(1) : "—"}
                </span>
                <span className="text-[var(--text-muted)] uppercase tracking-[0.1em]">total</span>
                <span
                  className="text-right font-semibold"
                  style={{ color: "var(--accent)" }}
                >
                  {hoverDay.cumulative.toLocaleString()}
                </span>
              </div>
            </div>
            {/* Down-pointing arrow */}
            <div
              className="mx-auto"
              style={{
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: "6px solid var(--accent)",
                filter: "drop-shadow(0 1px 2px rgba(153,69,255,0.4))",
              }}
            />
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-1 w-3" style={{ background: "var(--accent)" }} />
          cumulative
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-1 w-3"
            style={{
              background:
                "repeating-linear-gradient(90deg, var(--cyan) 0 3px, transparent 3px 6px)",
            }}
          />
          7-day moving avg
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2" style={{ background: "var(--cyan)", opacity: 0.4 }} />
          daily new
        </span>
      </div>
    </div>
  );
}

function tierColor(tier: number): string {
  // A = solid accent, B = cyan, C = amber, D+ = dim.
  if (tier === 0) return "var(--accent)";
  if (tier === 1) return "var(--cyan)";
  if (tier === 2) return "#fbbf24";
  return "var(--text-secondary)";
}

// Fetcher is now built inside the component from useAdminFetch so the
// Privy access + identity tokens get attached to every admin call.

function truncatePubkey(pubkey: string | null): string {
  if (!pubkey) return "—";
  if (pubkey.length <= 12) return pubkey;
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * Operator view of who's brought in the most waitlist signups.
 *
 * Backed by /api/admin/waitlist/leaderboard (requireAdminSession +
 * service-role read of waitlist_referral_leaderboard()). Returns full
 * identifiers — referral_code, pubkey, email, twitter_handle — so the
 * operator can correlate attribution with on-chain or off-chain
 * activity for that referrer.
 *
 * This is NOT a public-facing leaderboard. Adding one of those needs
 * a sanitisation layer + sign-off on the gamification surface.
 */
export function WaitlistLeaderboardSection() {
  const adminFetch = useAdminFetch();
  const fetcher = useMemo(
    () => async (url: string) => {
      const res = await adminFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [adminFetch],
  );

  const [limit, setLimit] = useState<10 | 25 | 100>(25);
  const { data, error, isLoading, mutate } = useSWR<{
    leaderboard: AdminLeaderboardEntry[];
  }>("/api/admin/waitlist/leaderboard", fetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });

  // Pending referral-code email backfill for legacy email-path signups
  // who never received their code (the security review intentionally
  // prevents the duplicate-email signup path from echoing the code).
  const { data: backfill, mutate: refreshBackfill } = useSWR<{
    pending: number;
  }>("/api/admin/waitlist/backfill-emails", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  });

  // Full integrity report — verifies the schema backfill assigned codes
  // to every row, codes are unique, no orphan referred_by_code values,
  // and shows the wallet/email/twitter breakdown.
  const { data: stats } = useSWR<WaitlistStats>(
    "/api/admin/waitlist/stats",
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: true },
  );
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);

  const rows = (data?.leaderboard ?? []).slice(0, limit);
  const totalReferrers = data?.leaderboard.length ?? 0;
  const totalSignupsAttributed = (data?.leaderboard ?? []).reduce(
    (sum, r) => sum + r.signupsReferred,
    0,
  );

  const runBackfill = async () => {
    if (backfillBusy) return;
    const pending = backfill?.pending ?? 0;
    if (pending === 0) return;
    const ok = window.confirm(
      `Send referral-code emails to ${pending} pending recipient${
        pending === 1 ? "" : "s"
      }? This is rate-limited at ~4/sec and may take multiple clicks if there are more than 80 pending.`,
    );
    if (!ok) return;

    setBackfillBusy(true);
    setBackfillStatus("Sending…");
    try {
      let totalSent = 0;
      let totalFailed = 0;
      // Loop until no pending rows remain or an update-flag failure halts
      // the run (which the server mirrors from the CLI script — re-running
      // after a flag-failure would double-email those users).
      while (true) {
        const res = await adminFetch("/api/admin/waitlist/backfill-emails", {
          method: "POST",
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body.error || `Backfill failed with HTTP ${res.status}`,
          );
        }
        const json = (await res.json()) as {
          processed: number;
          sent: number;
          failed: number;
          updateFailed: number;
          remaining: number;
        };
        totalSent += json.sent;
        totalFailed += json.failed;
        if (json.updateFailed > 0) {
          throw new Error(
            "A row was emailed but its flag could not be updated — manual reconciliation required before retrying.",
          );
        }
        setBackfillStatus(
          `Sent ${totalSent} so far · ${json.remaining} remaining`,
        );
        if (json.remaining === 0 || json.processed === 0) break;
      }
      setBackfillStatus(
        `Done. Sent ${totalSent}${
          totalFailed > 0 ? `, ${totalFailed} failed` : ""
        }.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBackfillStatus(`Failed: ${msg}`);
    } finally {
      setBackfillBusy(false);
      refreshBackfill();
    }
  };

  return (
    <div className="mb-8">
      <SectionHeader>Waitlist Health</SectionHeader>

      {/* Integrity check — answers "did the SQL backfill run, are
          codes unique, is anything orphaned?". Hidden until first
          fetch resolves so we never flash misleading zeroes. */}
      {stats ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Total Signups</div>
              <div className="text-3xl font-bold mt-1 text-[var(--text)]">
                {stats.totalSignups.toLocaleString()}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                +{stats.recency.last24h} in 24h · +{stats.recency.last7d} in 7d
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Code Coverage</div>
              <div
                className="text-3xl font-bold mt-1"
                style={{
                  color: stats.integrity.backfillComplete
                    ? "var(--cyan)"
                    : "var(--short)",
                }}
              >
                {stats.codeAssignment.withCode}/{stats.totalSignups}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.integrity.backfillComplete
                  ? "every row has a code ✓"
                  : `${stats.codeAssignment.withoutCode} missing — backfill incomplete`}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Attributed Signups</div>
              <div
                className="text-3xl font-bold mt-1"
                style={{ color: "var(--accent)" }}
              >
                {stats.attribution.withReferrer}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.attribution.withoutReferrer.toLocaleString()} pre-invite (grandfathered)
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Email Notification</div>
              <div className="text-3xl font-bold mt-1 text-[var(--text)]">
                {stats.emailNotification.notifiedTotal}
              </div>
              <div className="text-[11px] text-[var(--text-muted)] mt-1">
                {stats.emailNotification.pendingEmailable > 0
                  ? `${stats.emailNotification.pendingEmailable} pending · ${stats.emailNotification.walletOnlyNoEmail} wallet-only`
                  : `${stats.emailNotification.walletOnlyNoEmail} wallet-only (no email)`}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Wallet Only</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.walletOnly.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Email Only</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.emailOnly.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>Wallet + Email</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.walletAndEmail.toLocaleString()}
              </div>
            </div>
            <div className={`${card} p-4`}>
              <div className={labelStyle}>With Twitter Handle</div>
              <div className="text-2xl font-bold mt-1 text-[var(--text)]">
                {stats.byMethod.withTwitter.toLocaleString()}
              </div>
            </div>
          </div>

          {/* 30-day growth chart — daily bars + cumulative line */}
          {stats.growth && stats.growth.days.length > 0 && (
            <GrowthChart days={stats.growth.days} />
          )}

          {/* Referral tier breakdown — A = the 126 pre-invite roots, B = referred by A, etc. */}
          {stats.tierBreakdown && stats.tierBreakdown.length > 0 && (
            <div className={`${card} p-4 mb-4`}>
              <div className={`${labelStyle} mb-3`}>Referral Tiers</div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                {stats.tierBreakdown.map(({ tier, count, label }) => (
                  <div
                    key={tier}
                    className="rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/40 p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
                        style={{
                          color: tierColor(tier),
                          borderColor: `${tierColor(tier)}66`,
                          backgroundColor: `${tierColor(tier)}14`,
                        }}
                      >
                        {label}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
                        tier {tier}
                      </span>
                    </div>
                    <div
                      className="mt-1 font-mono text-[18px] font-bold text-[var(--text)]"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {count.toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] text-[var(--text-muted)]">
                Tier = generation in the referral tree. A = pre-invite roots (the 126
                grandfathered signups), B = referred by an A, C = referred by a B, etc.
              </p>
            </div>
          )}

          {/* Integrity checks — green tick or red flag for each invariant */}
          <div className={`${card} p-4 mb-4`}>
            <div className={`${labelStyle} mb-3`}>Integrity Checks</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[12.5px]">
              <IntegrityRow
                ok={stats.integrity.backfillComplete}
                label="Every row has a referral_code"
                detail={
                  stats.integrity.backfillComplete
                    ? `${stats.codeAssignment.withCode} of ${stats.totalSignups}`
                    : `${stats.codeAssignment.withoutCode} rows missing a code — re-run the SQL backfill`
                }
              />
              <IntegrityRow
                ok={stats.integrity.codesUnique}
                label="All referral codes are unique"
                detail={
                  stats.integrity.codesUnique
                    ? `${stats.codeAssignment.distinctCodes} distinct codes`
                    : `${stats.codeAssignment.duplicateCodes.length} duplicate(s): ${stats.codeAssignment.duplicateCodes
                        .slice(0, 5)
                        .map((d) => `${d.code}(×${d.count})`)
                        .join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.allCodesValidShape}
                label="All codes match Crockford base32 × 8"
                detail={
                  stats.integrity.allCodesValidShape
                    ? "no malformed codes"
                    : `${stats.codeAssignment.malformedCodes.length} bad: ${stats.codeAssignment.malformedCodes.slice(0, 5).join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.noOrphanedReferrers}
                label="Every referred_by_code points at a real code"
                detail={
                  stats.integrity.noOrphanedReferrers
                    ? "no orphans"
                    : `${stats.attribution.orphanedReferrers.length} orphan(s): ${stats.attribution.orphanedReferrers.slice(0, 5).join(", ")}`
                }
              />
              <IntegrityRow
                ok={stats.integrity.selfReferrals === 0}
                label="No self-referrals"
                detail={
                  stats.integrity.selfReferrals === 0
                    ? "clean"
                    : `${stats.integrity.selfReferrals} row(s) reference their own code`
                }
              />
            </div>
          </div>

          {/* Spam & quality signals — heuristics over the full table */}
          {stats.spam && (
            <SpamSignals total={stats.totalSignups} spam={stats.spam} />
          )}
        </>
      ) : (
        <div className={`${card} p-4 mb-4 text-[12px] text-[var(--text-muted)]`}>
          Loading waitlist health…
        </div>
      )}

      <SectionHeader>Waitlist Referral Leaderboard</SectionHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div className={`${card} p-4`}>
          <div className={labelStyle}>Active Referrers</div>
          <div className="text-3xl font-bold mt-1 text-[var(--cyan)]">
            {totalReferrers.toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            with ≥ 1 invitee
          </div>
        </div>

        <div className={`${card} p-4`}>
          <div className={labelStyle}>Attributed Signups</div>
          <div
            className="text-3xl font-bold mt-1"
            style={{ color: "var(--accent)" }}
          >
            {totalSignupsAttributed.toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            joined via a code
          </div>
        </div>

        <div className={`${card} p-4`}>
          <div className={labelStyle}>Top Referrer</div>
          <div className="text-xl font-bold mt-1 text-[var(--text)] truncate">
            {rows[0]
              ? rows[0].twitterHandle
                ? `@${rows[0].twitterHandle.replace(/^@/, "")}`
                : rows[0].referralCode
              : "—"}
          </div>
          <div className="text-[11px] text-[var(--text-muted)] mt-1">
            {rows[0]
              ? `${rows[0].signupsReferred.toLocaleString()} invites`
              : "no data yet"}
          </div>
        </div>

        <div className={`${card} p-4 flex flex-col`}>
          <div className={labelStyle}>Show</div>
          <div className="mt-1 flex gap-1.5">
            {[10, 25, 100].map((n) => (
              <button
                key={n}
                onClick={() => setLimit(n as 10 | 25 | 100)}
                className={`flex-1 rounded-none border px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors ${
                  limit === n
                    ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <button
            onClick={() => mutate()}
            className="mt-2 rounded-none border border-[var(--border)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-[var(--text)] hover:border-[var(--border-hover)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Pending email backfill — legacy email signups who haven't been
          notified of their code. Hidden when the queue is empty. */}
      {(backfill?.pending ?? 0) > 0 || backfillStatus ? (
        <div className={`${card} p-4 mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
          <div className="flex-1">
            <div className={labelStyle}>Email backfill pending</div>
            <div className="mt-1 text-[13px] text-[var(--text-secondary)]">
              {(backfill?.pending ?? 0) > 0
                ? `${backfill?.pending.toLocaleString()} email-path signup${
                    backfill?.pending === 1 ? "" : "s"
                  } never received their referral code.`
                : "All caught up — no pending backfill."}
              {backfillStatus ? (
                <span className="ml-2 font-mono text-[11px] text-[var(--text-muted)]">
                  · {backfillStatus}
                </span>
              ) : null}
            </div>
          </div>
          <button
            onClick={runBackfill}
            disabled={backfillBusy || (backfill?.pending ?? 0) === 0}
            className="shrink-0 rounded-none border border-[var(--accent)]/60 bg-[var(--accent)]/[0.12] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--text)] transition-colors hover:bg-[var(--accent)]/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {backfillBusy ? "Sending…" : "Send referral emails"}
          </button>
        </div>
      ) : null}

      <div className={card}>
        {error ? (
          <div className="p-4 text-[12px] text-[var(--short)]">
            Failed to load leaderboard.
          </div>
        ) : isLoading && !data ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-[12px] text-[var(--text-muted)]">
            No referrals attributed yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Rank
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Tier
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Code
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Twitter
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Pubkey
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Email
                  </th>
                  <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.12em]">
                    Invites
                  </th>
                  <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.12em]">
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.referralCode}
                    className="border-b border-[var(--border)]/40 last:border-b-0"
                  >
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)]">
                      #{row.rank}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]"
                        style={{
                          color: tierColor(row.tier ?? 0),
                          borderColor: `${tierColor(row.tier ?? 0)}66`,
                          backgroundColor: `${tierColor(row.tier ?? 0)}14`,
                        }}
                      >
                        {tierLabel(row.tier ?? 0)}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono font-bold text-[var(--text)]">
                      {row.referralCode}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.twitterHandle ? (
                        <a
                          href={`https://x.com/${row.twitterHandle.replace(/^@/, "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[var(--accent)] hover:underline"
                        >
                          @{row.twitterHandle.replace(/^@/, "")}
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.ownerPubkey ? (
                        <a
                          href={`https://solscan.io/account/${row.ownerPubkey}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-[var(--accent)] hover:underline"
                          title={row.ownerPubkey}
                        >
                          {truncatePubkey(row.ownerPubkey)}
                        </a>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-secondary)]">
                      {row.ownerEmail ?? (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-[var(--accent)]">
                      {row.signupsReferred.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)]">
                      {formatDate(row.joinedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
