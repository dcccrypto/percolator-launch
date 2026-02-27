"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient, type User } from "@supabase/supabase-js";

function getAuthClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface BugReport {
  id: string;
  twitter_handle: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  page: string | null;
  page_url: string | null;
  bounty_wallet: string | null;
  transaction_wallet: string | null;
  browser: string | null;
  steps_to_reproduce: string | null;
  expected_behavior: string | null;
  actual_behavior: string | null;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface MarketStat {
  slab_address: string;
  symbol: string | null;
  total_open_interest: number | null;
  open_interest_long: number | null;
  open_interest_short: number | null;
  volume_24h: number | null;
  last_price: number | null;
  price_change_24h: number | null;
  trade_count_24h: number | null;
}

interface HealthCheck {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

interface PlatformHealth {
  status: "healthy" | "degraded" | "unknown";
  checks: Record<string, HealthCheck>;
}

interface PlatformStats {
  totalMarkets: number;
  totalVolume24h: number;
  totalOpenInterest: number;
  trades24h: number;
  health: PlatformHealth;
}

type StatusFilter =
  | "all"
  | "open"
  | "investigating"
  | "fixed"
  | "unpaid"
  | "paid"
  | "wont_fix"
  | "duplicate"
  | "invalid";
type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUSES = [
  "open",
  "investigating",
  "fixed",
  "unpaid",
  "paid",
  "wont_fix",
  "duplicate",
  "invalid",
] as const;

const STATUS_COLORS: Record<string, string> = {
  open: "var(--warning)",
  investigating: "var(--accent)",
  fixed: "var(--cyan)",
  unpaid: "#FF6B35",
  paid: "var(--long)",
  wont_fix: "var(--text-muted)",
  duplicate: "var(--text-muted)",
  invalid: "var(--text-muted)",
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "var(--short)",
  high: "#FF6B35",
  medium: "var(--warning)",
  low: "var(--text-secondary)",
};

// ─── Style tokens ─────────────────────────────────────────────────────────────

const card =
  "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle =
  "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";
const inputStyle =
  "w-full rounded-none border border-[var(--border)] bg-[#0D0D14] px-3 py-2 text-[12px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors";

// ─── Small helpers ─────────────────────────────────────────────────────────────

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-[6px] h-[6px] rounded-full mr-1.5 shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function TimeAgo({ date }: { date: string }) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  const text =
    days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : `${mins}m ago`;
  return (
    <span className="text-[11px] text-[var(--text-muted)]">{text}</span>
  );
}

function truncateId(id: string) {
  return id.slice(0, 8);
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// ─── Analytics helpers ────────────────────────────────────────────────────────

function computeBountyAnalytics(bugs: BugReport[]) {
  const paid = bugs.filter((b) => b.status === "paid");
  const unpaid = bugs.filter((b) => b.status === "unpaid");
  const actionable = bugs.filter((b) =>
    ["fixed", "paid", "unpaid"].includes(b.status)
  );

  // Avg time to resolve: updated_at - created_at for actionable bugs
  const fixTimesHours = actionable
    .map((b) => {
      const created = new Date(b.created_at).getTime();
      const updated = new Date(b.updated_at).getTime();
      return (updated - created) / 3_600_000;
    })
    .filter((h) => h > 0);
  const avgFixHours =
    fixTimesHours.length > 0
      ? fixTimesHours.reduce((a, b) => a + b, 0) / fixTimesHours.length
      : null;

  // Severity breakdown
  const bySeverity: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const b of bugs) {
    if (b.severity in bySeverity) bySeverity[b.severity]++;
  }

  // Status breakdown
  const byStatus: Record<string, number> = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const b of bugs) {
    if (b.status in byStatus) byStatus[b.status]++;
  }

  // Top reporters (by total; secondary sort by paid)
  const reporterMap: Record<
    string,
    { total: number; paid: number; critical: number }
  > = {};
  for (const b of bugs) {
    if (!reporterMap[b.twitter_handle]) {
      reporterMap[b.twitter_handle] = { total: 0, paid: 0, critical: 0 };
    }
    reporterMap[b.twitter_handle].total++;
    if (b.status === "paid") reporterMap[b.twitter_handle].paid++;
    if (b.severity === "critical") reporterMap[b.twitter_handle].critical++;
  }
  const topReporters = Object.entries(reporterMap)
    .map(([handle, s]) => ({ handle, ...s }))
    .sort((a, b) => b.total - a.total || b.paid - a.paid)
    .slice(0, 7);

  // Recent activity: last 15 bugs sorted by updated_at
  const recentActivity = [...bugs]
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )
    .slice(0, 15);

  return {
    paidCount: paid.length,
    unpaidCount: unpaid.length,
    uniquePaidWallets: new Set(paid.map((b) => b.bounty_wallet).filter(Boolean))
      .size,
    avgFixHours,
    bySeverity,
    byStatus,
    topReporters,
    recentActivity,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BarRow({
  label,
  count,
  total,
  color,
  onClick,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
  onClick?: () => void;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <button
      onClick={onClick}
      className="w-full group text-left"
      disabled={!onClick}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-[11px] font-medium capitalize group-hover:text-white transition-colors"
          style={{ color }}
        >
          {label.replace("_", " ")}
        </span>
        <span className="text-[11px] text-[var(--text-muted)]">
          {count}
          <span className="text-[var(--text-dim)] ml-1">
            ({pct.toFixed(0)}%)
          </span>
        </span>
      </div>
      <div className="h-[3px] bg-[var(--border)] rounded-none overflow-hidden">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </button>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className={labelStyle}>{children}</div>
      <div className="flex-1 h-px bg-[var(--border)]" />
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AdminDashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [selectedBug, setSelectedBug] = useState<BugReport | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(
    null
  );
  const [statsLoading, setStatsLoading] = useState(false);

  // ── Auth ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    getAuthClient()
      .auth.getUser()
      .then(async ({ data }) => {
        if (!data.user) {
          router.push("/admin/login");
          return;
        }
        const { data: adminRow } = await getAuthClient()
          .from("admin_users")
          .select("id")
          .eq("email", data.user.email!)
          .maybeSingle();
        if (!adminRow) {
          await getAuthClient().auth.signOut();
          router.push("/admin/login");
          return;
        }
        setUser(data.user);
        setLoading(false);
      });
  }, [router]);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const fetchBugs = useCallback(async () => {
    const { data } = await getAuthClient()
      .from("bug_reports")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setBugs(data as BugReport[]);
  }, []);

  const fetchPlatformStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const [marketsRes, healthRes] = await Promise.all([
        getAuthClient()
          .from("markets_with_stats")
          .select(
            "slab_address, total_open_interest, open_interest_long, open_interest_short, volume_24h, trade_count_24h"
          ),
        fetch("/api/health")
          .then((r) => r.json())
          .catch(() => ({ status: "unknown", checks: {} })),
      ]);

      const markets = (marketsRes.data ?? []) as MarketStat[];
      setPlatformStats({
        totalMarkets: markets.length,
        totalVolume24h: markets.reduce((s, m) => s + (m.volume_24h ?? 0), 0),
        totalOpenInterest: markets.reduce(
          (s, m) =>
            s + ((m.open_interest_long ?? 0) + (m.open_interest_short ?? 0)),
          0
        ),
        trades24h: markets.reduce((s, m) => s + (m.trade_count_24h ?? 0), 0),
        health: {
          status: healthRes.status ?? "unknown",
          checks: healthRes.checks ?? {},
        },
      });
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      fetchBugs();
      fetchPlatformStats();
    }
  }, [user, fetchBugs, fetchPlatformStats]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const updateStatus = async (bugId: string, newStatus: string) => {
    setSaving(true);
    await getAuthClient()
      .from("bug_reports")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", bugId);
    await fetchBugs();
    if (selectedBug?.id === bugId) {
      setSelectedBug((prev) => (prev ? { ...prev, status: newStatus } : null));
    }
    setSaving(false);
  };

  const saveNotes = async () => {
    if (!selectedBug) return;
    setSaving(true);
    await getAuthClient()
      .from("bug_reports")
      .update({
        admin_notes: adminNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", selectedBug.id);
    await fetchBugs();
    setSelectedBug((prev) =>
      prev ? { ...prev, admin_notes: adminNotes } : null
    );
    setSaving(false);
  };

  const signOut = async () => {
    await getAuthClient().auth.signOut();
    router.push("/admin/login");
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const filtered = bugs.filter((b) => {
    if (statusFilter !== "all" && b.status !== statusFilter) return false;
    if (severityFilter !== "all" && b.severity !== severityFilter) return false;
    return true;
  });

  const analytics = computeBountyAnalytics(bugs);

  const healthColor =
    platformStats?.health.status === "healthy"
      ? "var(--long)"
      : platformStats?.health.status === "degraded"
      ? "var(--warning)"
      : "var(--text-muted)";

  // ── Loading state ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[var(--text-muted)] text-[12px] uppercase tracking-[0.15em]">
          Loading...
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-[1400px] mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className={`${labelStyle} mb-1`}>Admin Dashboard</div>
          <h1 className="text-xl font-bold text-white">Percolator Admin</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-[11px] text-[var(--text-muted)]">
            {user?.email}
          </span>
          <button
            onClick={signOut}
            className="rounded-none border border-[var(--border)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-white hover:border-[var(--border-hover)] transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          BOUNTY ANALYTICS — primary section
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="mb-8">
        <SectionHeader>Bounty Analytics</SectionHeader>

        {/* KPI row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className={`${card} p-4`}>
            <div className={labelStyle}>Bounties Paid</div>
            <div className="text-3xl font-bold mt-1" style={{ color: "var(--long)" }}>
              {analytics.paidCount}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-1">
              {analytics.uniquePaidWallets} unique wallet
              {analytics.uniquePaidWallets !== 1 ? "s" : ""}
            </div>
          </div>

          <div className={`${card} p-4`}>
            <div className={labelStyle}>Awaiting Payment</div>
            <div className="text-3xl font-bold mt-1" style={{ color: "#FF6B35" }}>
              {analytics.unpaidCount}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-1">
              fixed but unpaid
            </div>
          </div>

          <div className={`${card} p-4`}>
            <div className={labelStyle}>Avg Time to Resolve</div>
            <div className="text-3xl font-bold mt-1" style={{ color: "var(--cyan)" }}>
              {analytics.avgFixHours != null
                ? formatDuration(analytics.avgFixHours)
                : "—"}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-1">
              fixed + paid + unpaid
            </div>
          </div>

          <div className={`${card} p-4`}>
            <div className={labelStyle}>Total Reports</div>
            <div className="text-3xl font-bold mt-1 text-white">
              {bugs.length}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-1">
              {bugs.filter((b) => b.severity === "critical").length} critical
            </div>
          </div>
        </div>

        {/* Analytics panels */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">

          {/* Severity breakdown */}
          <div className={`${card} p-4`}>
            <div className={`${labelStyle} mb-4`}>By Severity</div>
            <div className="space-y-3">
              {(["critical", "high", "medium", "low"] as const).map((sev) => (
                <BarRow
                  key={sev}
                  label={sev}
                  count={analytics.bySeverity[sev]}
                  total={bugs.length}
                  color={SEVERITY_COLORS[sev]}
                  onClick={() => setSeverityFilter(sev)}
                />
              ))}
            </div>
          </div>

          {/* Status breakdown */}
          <div className={`${card} p-4`}>
            <div className={`${labelStyle} mb-4`}>By Status</div>
            <div className="space-y-3">
              {STATUSES.map((s) => (
                <BarRow
                  key={s}
                  label={s}
                  count={analytics.byStatus[s]}
                  total={bugs.length}
                  color={STATUS_COLORS[s] || "var(--text-muted)"}
                  onClick={() => setStatusFilter(s as StatusFilter)}
                />
              ))}
            </div>
          </div>

          {/* Top reporters */}
          <div className={`${card} p-4`}>
            <div className={`${labelStyle} mb-4`}>Top Reporters</div>
            {analytics.topReporters.length === 0 ? (
              <div className="text-[12px] text-[var(--text-muted)] py-4 text-center">
                No reports yet
              </div>
            ) : (
              <div className="space-y-2">
                {analytics.topReporters.map((r, i) => (
                  <div
                    key={r.handle}
                    className="flex items-center gap-3 py-1.5 border-b border-[var(--border)] last:border-0"
                  >
                    {/* rank */}
                    <span
                      className="text-[11px] font-bold w-4 text-right shrink-0"
                      style={{
                        color:
                          i === 0
                            ? "var(--warning)"
                            : i === 1
                            ? "var(--text-secondary)"
                            : "var(--text-dim)",
                      }}
                    >
                      {i + 1}
                    </span>
                    {/* handle */}
                    <span className="flex-1 text-[12px] text-[var(--accent)] truncate">
                      @{r.handle}
                    </span>
                    {/* badges */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {r.critical > 0 && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 border"
                          style={{
                            color: "var(--short)",
                            borderColor: "var(--short)",
                          }}
                        >
                          {r.critical}C
                        </span>
                      )}
                      {r.paid > 0 && (
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 border"
                          style={{
                            color: "var(--long)",
                            borderColor: "var(--long)",
                          }}
                        >
                          {r.paid}✓
                        </span>
                      )}
                      <span className="text-[12px] font-bold text-white w-5 text-right">
                        {r.total}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity timeline */}
        <div className={`${card} p-4`}>
          <div className={`${labelStyle} mb-4`}>Recent Activity</div>
          {analytics.recentActivity.length === 0 ? (
            <div className="text-[12px] text-[var(--text-muted)] text-center py-4">
              No activity yet
            </div>
          ) : (
            <div className="relative">
              {/* vertical line */}
              <div className="absolute left-[7px] top-2 bottom-2 w-px bg-[var(--border)]" />
              <div className="space-y-0">
                {analytics.recentActivity.map((bug, i) => (
                  <button
                    key={bug.id}
                    onClick={() => {
                      setSelectedBug(bug);
                      setAdminNotes(bug.admin_notes || "");
                      // scroll list into view on mobile
                    }}
                    className="w-full text-left flex items-start gap-4 py-2 pl-1 hover:bg-[var(--bg-elevated)] transition-colors rounded-none group"
                  >
                    {/* timeline dot */}
                    <span
                      className="relative z-10 mt-[3px] w-[8px] h-[8px] rounded-full shrink-0 border-2"
                      style={{
                        backgroundColor:
                          STATUS_COLORS[bug.status] || "var(--border)",
                        borderColor:
                          i === 0
                            ? STATUS_COLORS[bug.status] || "var(--border)"
                            : "var(--panel-bg)",
                        boxShadow:
                          i === 0
                            ? `0 0 6px ${STATUS_COLORS[bug.status] || "transparent"}`
                            : "none",
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px] text-white truncate max-w-[220px] group-hover:text-[var(--accent)] transition-colors">
                          {bug.title}
                        </span>
                        <span
                          className="text-[10px] font-bold uppercase tracking-[0.1em] px-1.5 py-0.5 border shrink-0"
                          style={{
                            color:
                              STATUS_COLORS[bug.status] || "var(--text-muted)",
                            borderColor:
                              STATUS_COLORS[bug.status] || "var(--border)",
                          }}
                        >
                          {bug.status.replace("_", " ")}
                        </span>
                        <span
                          className="text-[10px] font-bold uppercase shrink-0"
                          style={{
                            color:
                              SEVERITY_COLORS[bug.severity] ||
                              "var(--text-muted)",
                          }}
                        >
                          {bug.severity}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--text-muted)]">
                        <span className="text-[var(--accent)]">
                          @{bug.twitter_handle}
                        </span>
                        <TimeAgo date={bug.updated_at} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          PLATFORM STATS
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="mb-8">
        <SectionHeader>Platform Stats</SectionHeader>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className={`${card} p-4`}>
            <div className={labelStyle}>Markets</div>
            <div className="text-2xl font-bold mt-1 text-[var(--text)]">
              {statsLoading ? "—" : (platformStats?.totalMarkets ?? "—")}
            </div>
          </div>
          <div className={`${card} p-4`}>
            <div className={labelStyle}>24h Volume</div>
            <div className="text-2xl font-bold mt-1 text-[var(--accent)]">
              {statsLoading
                ? "—"
                : platformStats
                ? formatCompact(platformStats.totalVolume24h)
                : "—"}
            </div>
          </div>
          <div className={`${card} p-4`}>
            <div className={labelStyle}>Open Interest</div>
            <div className="text-2xl font-bold mt-1 text-[var(--cyan)]">
              {statsLoading
                ? "—"
                : platformStats
                ? formatCompact(platformStats.totalOpenInterest)
                : "—"}
            </div>
          </div>
          <div className={`${card} p-4`}>
            <div className={labelStyle}>24h Trades</div>
            <div className="text-2xl font-bold mt-1 text-[var(--text-secondary)]">
              {statsLoading ? "—" : (platformStats?.trades24h ?? "—")}
            </div>
          </div>
          <div className={`${card} p-4 col-span-2 md:col-span-1`}>
            <div className={labelStyle}>System Health</div>
            <div
              className="text-lg font-bold mt-1 capitalize"
              style={{ color: healthColor }}
            >
              {statsLoading ? "—" : (platformStats?.health.status ?? "—")}
            </div>
            {!statsLoading && platformStats && (
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {Object.entries(platformStats.health.checks).map(
                  ([name, check]) => (
                    <span
                      key={name}
                      className="text-[10px] text-[var(--text-muted)]"
                    >
                      <span
                        className="inline-block w-[5px] h-[5px] rounded-full mr-1 mb-[1px]"
                        style={{
                          backgroundColor:
                            check.status === "ok"
                              ? "var(--long)"
                              : "var(--short)",
                        }}
                      />
                      {name}
                    </span>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          BUG LIST + DETAIL PANEL
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="mb-4">
        <SectionHeader>Bug Reports</SectionHeader>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div>
          <div className={`${labelStyle} mb-1`}>Status</div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className={`${inputStyle} w-[160px]`}
          >
            <option value="all">All Statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className={`${labelStyle} mb-1`}>Severity</div>
          <select
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as SeverityFilter)
            }
            className={`${inputStyle} w-[160px]`}
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            onClick={() => {
              setStatusFilter("all");
              setSeverityFilter("all");
            }}
            className="rounded-none border border-[var(--border)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)] hover:text-white hover:border-[var(--border-hover)] transition-colors"
          >
            Clear
          </button>
          <button
            onClick={() => {
              fetchBugs();
              fetchPlatformStats();
            }}
            className="rounded-none border border-[var(--border)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-white hover:border-[var(--accent)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* List + Detail — stacked on mobile, side by side on lg+ */}
      <div className="flex flex-col lg:flex-row gap-4">

        {/* Bug list */}
        <div className={`${card} overflow-hidden flex-1 min-w-0`}>
          <div className="border-b border-[var(--border)] px-4 py-3">
            <span className={labelStyle}>
              {filtered.length} Report{filtered.length !== 1 ? "s" : ""}
              {statusFilter !== "all" || severityFilter !== "all"
                ? " (filtered)"
                : ""}
            </span>
          </div>

          <div className="divide-y divide-[var(--border)]">
            {filtered.length === 0 ? (
              <div className="p-8 text-center text-[var(--text-muted)] text-[12px]">
                No bugs match filters
              </div>
            ) : (
              filtered.map((bug) => (
                <button
                  key={bug.id}
                  onClick={() => {
                    setSelectedBug(bug);
                    setAdminNotes(bug.admin_notes || "");
                  }}
                  className={`w-full text-left px-4 py-3 hover:bg-[var(--bg-elevated)] transition-colors ${
                    selectedBug?.id === bug.id
                      ? "bg-[var(--accent-subtle)] border-l-2 border-l-[var(--accent)]"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot
                          color={
                            SEVERITY_COLORS[bug.severity] ||
                            "var(--text-muted)"
                          }
                        />
                        <span className="text-[13px] font-medium text-white truncate">
                          {bug.title}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        <span className="text-[var(--accent)]">
                          @{bug.twitter_handle}
                        </span>
                        <span className="text-[var(--text-dim)]">
                          {truncateId(bug.id)}
                        </span>
                        <TimeAgo date={bug.created_at} />
                      </div>
                    </div>
                    <div className="shrink-0">
                      <span
                        className="text-[10px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 border rounded-none"
                        style={{
                          color:
                            STATUS_COLORS[bug.status] || "var(--text-muted)",
                          borderColor:
                            STATUS_COLORS[bug.status] || "var(--border)",
                        }}
                      >
                        {bug.status.replace("_", " ")}
                      </span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Detail panel — sticky on desktop so it stays visible while scrolling the bug list */}
        <div
          className={`${card} lg:w-[400px] lg:shrink-0 overflow-y-auto max-h-[calc(100vh-6rem)] lg:sticky lg:top-[5rem]`}
        >
          {!selectedBug ? (
            <div className="text-center text-[var(--text-muted)] text-[12px] py-12 px-4">
              Select a bug report to view details
            </div>
          ) : (
            <div className="p-4 space-y-4">
              {/* Title & meta */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <StatusDot color={SEVERITY_COLORS[selectedBug.severity]} />
                  <span
                    className="text-[10px] font-bold uppercase tracking-[0.1em]"
                    style={{ color: SEVERITY_COLORS[selectedBug.severity] }}
                  >
                    {selectedBug.severity}
                  </span>
                </div>
                <h2 className="text-[15px] font-bold text-white leading-tight mb-2">
                  {selectedBug.title}
                </h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className="text-[var(--accent)]">
                    @{selectedBug.twitter_handle}
                  </span>
                  <span className="text-[var(--text-dim)]">
                    {truncateId(selectedBug.id)}
                  </span>
                  <TimeAgo date={selectedBug.created_at} />
                  {selectedBug.page && (
                    <span className="text-[var(--text-muted)]">
                      Page: {selectedBug.page}
                    </span>
                  )}
                </div>
              </div>

              {/* Description */}
              <div>
                <div className={`${labelStyle} mb-1`}>Description</div>
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">
                  {selectedBug.description}
                </p>
              </div>

              {selectedBug.steps_to_reproduce && (
                <div>
                  <div className={`${labelStyle} mb-1`}>Steps to Reproduce</div>
                  <p className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap">
                    {selectedBug.steps_to_reproduce}
                  </p>
                </div>
              )}
              {selectedBug.expected_behavior && (
                <div>
                  <div className={`${labelStyle} mb-1`}>Expected</div>
                  <p className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap">
                    {selectedBug.expected_behavior}
                  </p>
                </div>
              )}
              {selectedBug.actual_behavior && (
                <div>
                  <div className={`${labelStyle} mb-1`}>Actual</div>
                  <p className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap">
                    {selectedBug.actual_behavior}
                  </p>
                </div>
              )}

              {/* Wallets */}
              {(selectedBug.bounty_wallet ||
                selectedBug.transaction_wallet) && (
                <div>
                  <div className={`${labelStyle} mb-1`}>Wallets</div>
                  {selectedBug.bounty_wallet && (
                    <div className="text-[11px] text-[var(--text-secondary)] mb-1 break-all">
                      <span className="text-[var(--text-muted)]">
                        Bounty:
                      </span>{" "}
                      <span className="font-mono">
                        {selectedBug.bounty_wallet}
                      </span>
                    </div>
                  )}
                  {selectedBug.transaction_wallet && (
                    <div className="text-[11px] text-[var(--text-secondary)] break-all">
                      <span className="text-[var(--text-muted)]">Tx:</span>{" "}
                      <span className="font-mono">
                        {selectedBug.transaction_wallet}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Browser / URL */}
              {(selectedBug.browser || selectedBug.page_url) && (
                <div className="flex flex-wrap gap-4 text-[11px]">
                  {selectedBug.browser && (
                    <div>
                      <span className="text-[var(--text-muted)]">
                        Browser:
                      </span>{" "}
                      <span className="text-[var(--text-secondary)]">
                        {selectedBug.browser}
                      </span>
                    </div>
                  )}
                  {selectedBug.page_url && (
                    <div className="min-w-0">
                      <span className="text-[var(--text-muted)]">URL:</span>{" "}
                      <a
                        href={selectedBug.page_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] hover:underline break-all"
                      >
                        {selectedBug.page_url}
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Status controls */}
              <div>
                <div className={`${labelStyle} mb-2`}>Set Status</div>
                <div className="flex flex-wrap gap-1.5">
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => updateStatus(selectedBug.id, s)}
                      disabled={saving || selectedBug.status === s}
                      className={`rounded-none border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] transition-colors ${
                        selectedBug.status === s
                          ? "bg-[var(--accent-subtle)] border-[var(--accent)] text-white"
                          : "border-[var(--border)] text-[var(--text-muted)] hover:text-white hover:border-[var(--border-hover)]"
                      }`}
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </div>

              {/* Admin notes */}
              <div>
                <div className={`${labelStyle} mb-1`}>Admin Notes</div>
                <textarea
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className={`${inputStyle} h-[80px] resize-none`}
                  placeholder="Internal notes, fix details, PR links..."
                />
                <button
                  onClick={saveNotes}
                  disabled={saving}
                  className="mt-2 rounded-none bg-[var(--accent)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save Notes"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
