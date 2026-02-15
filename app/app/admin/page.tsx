"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient, type User } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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

type StatusFilter = "all" | "open" | "investigating" | "fixed" | "unpaid" | "paid" | "wont_fix" | "duplicate" | "invalid";
type SeverityFilter = "all" | "critical" | "high" | "medium" | "low";

const STATUSES = ["open", "investigating", "fixed", "unpaid", "paid", "wont_fix", "duplicate", "invalid"] as const;

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

const card = "rounded-none bg-[var(--panel-bg)] border border-[var(--border)]";
const labelStyle = "text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-muted)]";
const inputStyle =
  "w-full rounded-none border border-[var(--border)] bg-[#0D0D14] px-3 py-2 text-[12px] text-white placeholder:text-[var(--text-dim)] focus:border-[var(--accent)] focus:outline-none transition-colors";

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-[6px] h-[6px] rounded-full mr-1.5"
      style={{ backgroundColor: color }}
    />
  );
}

function TimeAgo({ date }: { date: string }) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  const text = days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : `${mins}m ago`;
  return <span className="text-[11px] text-[var(--text-muted)]">{text}</span>;
}

function truncateId(id: string) {
  return id.slice(0, 8);
}

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

  // Auth check + admin whitelist
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        router.push("/admin/login");
        return;
      }
      // Check admin_users whitelist
      const { data: adminRow } = await supabase
        .from("admin_users")
        .select("id")
        .eq("email", data.user.email!)
        .maybeSingle();
      if (!adminRow) {
        await supabase.auth.signOut();
        router.push("/admin/login");
        return;
      }
      setUser(data.user);
      setLoading(false);
    });
  }, [router]);

  // Fetch bugs
  const fetchBugs = useCallback(async () => {
    const { data } = await supabase
      .from("bug_reports")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setBugs(data as BugReport[]);
  }, []);

  useEffect(() => {
    if (user) fetchBugs();
  }, [user, fetchBugs]);

  // Update bug status
  const updateStatus = async (bugId: string, newStatus: string) => {
    setSaving(true);
    await supabase
      .from("bug_reports")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", bugId);
    await fetchBugs();
    if (selectedBug?.id === bugId) {
      setSelectedBug((prev) => prev ? { ...prev, status: newStatus } : null);
    }
    setSaving(false);
  };

  // Save admin notes
  const saveNotes = async () => {
    if (!selectedBug) return;
    setSaving(true);
    await supabase
      .from("bug_reports")
      .update({ admin_notes: adminNotes, updated_at: new Date().toISOString() })
      .eq("id", selectedBug.id);
    await fetchBugs();
    setSelectedBug((prev) => prev ? { ...prev, admin_notes: adminNotes } : null);
    setSaving(false);
  };

  // Sign out
  const signOut = async () => {
    await supabase.auth.signOut();
    router.push("/admin/login");
  };

  // Filter
  const filtered = bugs.filter((b) => {
    if (statusFilter !== "all" && b.status !== statusFilter) return false;
    if (severityFilter !== "all" && b.severity !== severityFilter) return false;
    return true;
  });

  // Stats
  const stats = {
    total: bugs.length,
    open: bugs.filter((b) => b.status === "open").length,
    unpaid: bugs.filter((b) => b.status === "unpaid").length,
    paid: bugs.filter((b) => b.status === "paid").length,
    critical: bugs.filter((b) => b.severity === "critical" && b.status === "open").length,
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[var(--text-muted)] text-[12px] uppercase tracking-[0.15em]">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className={`${labelStyle} mb-1`}>Admin Dashboard</div>
          <h1 className="text-xl font-bold text-white">Bug Bounties</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-[var(--text-muted)]">{user?.email}</span>
          <button
            onClick={signOut}
            className="rounded-none border border-[var(--border)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-white hover:border-[var(--border-hover)] transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {[
          { label: "Total", value: stats.total, color: "var(--text)" },
          { label: "Open", value: stats.open, color: "var(--warning)" },
          { label: "Critical Open", value: stats.critical, color: "var(--short)" },
          { label: "Unpaid", value: stats.unpaid, color: "#FF6B35" },
          { label: "Paid", value: stats.paid, color: "var(--long)" },
        ].map((s) => (
          <div key={s.label} className={`${card} p-4`}>
            <div className={labelStyle}>{s.label}</div>
            <div className="text-2xl font-bold mt-1" style={{ color: s.color }}>
              {s.value}
            </div>
          </div>
        ))}
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
            onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}
            className={`${inputStyle} w-[160px]`}
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            onClick={fetchBugs}
            className="rounded-none border border-[var(--border)] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)] hover:text-white hover:border-[var(--accent)] transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
        {/* Bug List */}
        <div className={`${card} overflow-hidden`}>
          <div className="border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
            <span className={labelStyle}>
              {filtered.length} Report{filtered.length !== 1 ? "s" : ""}
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
                    selectedBug?.id === bug.id ? "bg-[var(--accent-subtle)] border-l-2 border-l-[var(--accent)]" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <StatusDot color={SEVERITY_COLORS[bug.severity] || "var(--text-muted)"} />
                        <span className="text-[13px] font-medium text-white truncate">
                          {bug.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px]">
                        <span className="text-[var(--accent)]">@{bug.twitter_handle}</span>
                        <span className="text-[var(--text-dim)]">{truncateId(bug.id)}</span>
                        <TimeAgo date={bug.created_at} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className="text-[10px] font-bold uppercase tracking-[0.1em] px-2 py-0.5 border rounded-none"
                        style={{
                          color: STATUS_COLORS[bug.status] || "var(--text-muted)",
                          borderColor: STATUS_COLORS[bug.status] || "var(--border)",
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

        {/* Detail Panel */}
        <div className={`${card} p-4 h-fit sticky top-4`}>
          {!selectedBug ? (
            <div className="text-center text-[var(--text-muted)] text-[12px] py-12">
              Select a bug report
            </div>
          ) : (
            <div className="space-y-4">
              {/* Title & Meta */}
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
                <div className="flex flex-wrap items-center gap-3 text-[11px]">
                  <span className="text-[var(--accent)]">@{selectedBug.twitter_handle}</span>
                  <span className="text-[var(--text-dim)]">{truncateId(selectedBug.id)}</span>
                  <TimeAgo date={selectedBug.created_at} />
                  {selectedBug.page && (
                    <span className="text-[var(--text-muted)]">Page: {selectedBug.page}</span>
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

              {/* Steps / Expected / Actual */}
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
              {(selectedBug.bounty_wallet || selectedBug.transaction_wallet) && (
                <div>
                  <div className={`${labelStyle} mb-1`}>Wallets</div>
                  {selectedBug.bounty_wallet && (
                    <div className="text-[11px] text-[var(--text-secondary)] mb-1">
                      <span className="text-[var(--text-muted)]">Bounty:</span>{" "}
                      <span className="font-mono">{selectedBug.bounty_wallet}</span>
                    </div>
                  )}
                  {selectedBug.transaction_wallet && (
                    <div className="text-[11px] text-[var(--text-secondary)]">
                      <span className="text-[var(--text-muted)]">Tx:</span>{" "}
                      <span className="font-mono">{selectedBug.transaction_wallet}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Browser / URL */}
              {(selectedBug.browser || selectedBug.page_url) && (
                <div className="flex gap-4 text-[11px]">
                  {selectedBug.browser && (
                    <div>
                      <span className="text-[var(--text-muted)]">Browser:</span>{" "}
                      <span className="text-[var(--text-secondary)]">{selectedBug.browser}</span>
                    </div>
                  )}
                  {selectedBug.page_url && (
                    <div>
                      <span className="text-[var(--text-muted)]">URL:</span>{" "}
                      <a
                        href={selectedBug.page_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] hover:underline"
                      >
                        {selectedBug.page_url}
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Status Controls */}
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

              {/* Admin Notes */}
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
